/**
 * The reviewer sign-in stage by stage, as the reviewer path shows it: a row
 * for each stage of the sign-in in the order the rehearsal meets them, then
 * who the identity check found, and what a person must do when the rehearsal
 * stops for one. Pure, so every state is a test.
 *
 * The rows come from the run that worked on the attempt last. A resumed
 * attempt signs in again from a clean browser, so an earlier run's stages
 * are history, not the state of the sign-in.
 */
import type {
  DirectoryReviewerIdentityEvidence,
  PlacedStep,
} from "@mcpjam/sdk/browser";
import type { ReviewerAttempt } from "@/lib/apis/reviewer-attempts-api";

export type ReviewerStage = ReviewerAttempt["stages"][number];

/** What the rehearsal puts before a stage it read off a page it only approximates. */
export const APPROXIMATED_PREFIX = "Approximated: ";

export const PATH_STATUS_WORDS = {
  established: "Established",
  failed: "Failed",
  waiting: "Needs a person",
  blocked: "Blocked",
  skipped: "Skipped",
  "not-tested": "Not tested",
  stale: "Stale",
  "wrong-account": "Wrong account",
  "wrong-tenant": "Wrong tenant",
  unverified: "Unverified",
} as const;

export type PathStatus = keyof typeof PATH_STATUS_WORDS;

/** A moment of the run's recording, which the rehearsal names as a frame. */
export interface Frame {
  recordingId: string;
  seconds: number;
}

export interface PathRow {
  key: string;
  label: string;
  status: PathStatus;
  detail?: string;
  /** Read off a sign-in page by a general rule, not one MCPJam knows. */
  approximated?: boolean;
  frame?: Frame;
}

export interface ReviewerPathRows {
  /** The run the rows come from. */
  runId?: string;
  /** Row 1's own stage, when the run recorded one. */
  credentials?: PathRow;
  /** Row 2 onward. */
  rows: PathRow[];
  /** The desktop reservation whose recording the frames point into. */
  recordingId?: string;
}

/**
 * The sign-in in the order the rehearsal meets it. A verification step is a
 * row only once a page asks for one, and the consent screen goes once the
 * reviewer connected without one.
 */
const SIGN_IN = [
  { stage: "connect-link", label: "Sign-in page", shown: "always" },
  { stage: "sign-in", label: "Fresh sign-in", shown: "always" },
  { stage: "verification", label: "Verification", shown: "recorded" },
  { stage: "consent", label: "Consent screen", shown: "until-passed" },
  { stage: "connected", label: "Reviewer connection", shown: "always" },
] as const;

const IDENTITY_CHECK = "both.reviewer.identity";
const FRAME = /^(.+)#t=(\d+(?:\.\d+)?)$/;

/** `<reservation id>#t=<seconds>`, the rehearsal's name for a frame. */
export function frameOf(id: string | undefined): Frame | undefined {
  const match = id ? FRAME.exec(id) : null;
  return match
    ? { recordingId: match[1], seconds: Number(match[2]) }
    : undefined;
}

/** The run the rows show, the one working now or else the last, and its stages. */
function shownRun(attempt: ReviewerAttempt | null) {
  // A resumed attempt whose new run has not joined shows nothing of the old one.
  const runId =
    attempt?.state === "running"
      ? attempt.currentRunId
      : attempt?.runIds.at(-1);
  const stages = attempt && runId ? attempt.stages : [];
  return { runId, stages: stages.filter((stage) => stage.runId === runId) };
}

export function stageStatus(
  status: ReviewerStage["status"],
  waiting: boolean,
): PathStatus {
  switch (status) {
    case "passed":
      return "established";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "blocked":
      return waiting ? "waiting" : "blocked";
  }
}

function unprefixed(detail: string | undefined) {
  const approximated = detail?.startsWith(APPROXIMATED_PREFIX) ?? false;
  return {
    detail: approximated ? detail?.slice(APPROXIMATED_PREFIX.length) : detail,
    approximated,
  };
}

/** A row no stage of the shown run fills, by how far the attempt got. */
function unreached(
  attempt: ReviewerAttempt | null,
  recorded: boolean,
): Pick<PathRow, "status" | "detail"> {
  switch (attempt?.state) {
    case "running":
      return { status: "not-tested", detail: "Not reached yet." };
    case "waiting-for-person":
      return { status: "blocked", detail: "Waits for the sign-in." };
  }
  return recorded
    ? {
        status: "not-tested",
        detail: "The last rehearsal stopped before this stage.",
      }
    : { status: "not-tested", detail: "Not tested yet." };
}

function identityDetail(
  status: PathStatus,
  finding: PlacedStep["findings"][number]["finding"],
): string | undefined {
  const evidence = finding.details as
    | Partial<DirectoryReviewerIdentityEvidence>
    | undefined;
  if (finding.status === "violated") return finding.remediation;
  if (status === "established" || status === "stale") {
    const { identity, organization } = evidence?.observed ?? {};
    const tool = evidence?.call?.tool ?? "The identity tool";
    if (identity && organization) {
      return `${tool} answers as ${identity} in ${organization}.`;
    }
    if (identity) return `${tool} answers as ${identity}.`;
    return organization ? `${tool} answers for ${organization}.` : undefined;
  }
  if (evidence?.outcome === "unverified" && evidence.reason) {
    return `MCPJam could not check who the reviewer is: ${evidence.reason}. Review the answers under Reviewer check, then run checks again.`;
  }
  // The SDK writes a missing dependency as "blocked: <why>".
  const why = finding.notEvaluatedReason?.replace(/^blocked: /, "");
  return why ? why.charAt(0).toUpperCase() + why.slice(1) : undefined;
}

/** Who the reviewer turned out to be, from the latest run's identity check. */
export function identityRow(
  steps: readonly PlacedStep[],
  attempt: ReviewerAttempt | null,
): PathRow {
  const row = { key: "identity", label: "Identity and tenant" };
  const placed = steps
    .flatMap((step) => step.findings)
    .find((entry) => entry.finding.id === IDENTITY_CHECK);
  if (!placed) return { ...row, ...unreached(attempt, false) };
  const { finding, evidenceStatus } = placed;
  const outcome = (
    finding.details as Partial<DirectoryReviewerIdentityEvidence> | undefined
  )?.outcome;
  let status: PathStatus;
  if (evidenceStatus === "stale") status = "stale";
  else if (finding.status === "satisfied") status = "established";
  else if (outcome === "wrong-account" || outcome === "wrong-tenant") {
    status = outcome;
  } else if (outcome === "unverified") status = "unverified";
  else if (finding.status === "violated") status = "failed";
  else status = evidenceStatus === "blocked" ? "blocked" : "not-tested";
  return { ...row, status, detail: identityDetail(status, finding) };
}

export function reviewerPathRows(
  attempt: ReviewerAttempt | null,
  steps: readonly PlacedStep[],
): ReviewerPathRows {
  const { runId, stages } = shownRun(attempt);
  const stop =
    attempt?.state === "waiting-for-person" ? stages.at(-1) : undefined;
  const latest = (name: ReviewerStage["stage"]) =>
    stages.filter((stage) => stage.stage === name).at(-1);
  const rowOf = (stage: ReviewerStage, label: string): PathRow => ({
    key: stage.stage,
    label,
    status: stageStatus(stage.status, stage === stop),
    ...unprefixed(stage.detail),
    frame: frameOf(stage.evidence?.screenshotArtifactId),
  });
  const credentials = latest("credentials");
  const rows = SIGN_IN.flatMap(({ stage: name, label, shown }, index) => {
    const stage = latest(name);
    if (stage) return [rowOf(stage, label)];
    const passed = SIGN_IN.slice(index + 1).some((later) =>
      latest(later.stage),
    );
    if (shown === "recorded" || (shown === "until-passed" && passed)) return [];
    return [{ key: name, label, ...unreached(attempt, stages.length > 0) }];
  });
  return {
    runId,
    credentials: credentials && rowOf(credentials, "Reviewer credentials"),
    rows: [...rows, identityRow(steps, attempt)],
    recordingId: stages.find((stage) => stage.evidence?.recordingArtifactId)
      ?.evidence?.recordingArtifactId,
  };
}

export interface Handover {
  /** What the page asked for, in the rehearsal's words. */
  asked: string;
  approximated: boolean;
  frame?: Frame;
  /** Who can change the sign-in. */
  finisher: string;
  /** The change, then: resume. */
  action: string;
  since: number;
}

/** The requester completes sign-in before a resumed run grades the account. */
const NEXT_STEPS = {
  verification: { finisher: "The person who started this sign-in.", action: "Open Finish reviewer sign-in, complete the verification, then resume this attempt." },
  "bot-check": { finisher: "The person who started this sign-in.", action: "Open Finish reviewer sign-in, complete the browser check, then resume this attempt." },
  consent: { finisher: "The person who started this sign-in.", action: "Open Finish reviewer sign-in, approve access, then resume this attempt." },
  other: { finisher: "The person who started this sign-in.", action: "Open Finish reviewer sign-in, sign in as the reviewer, then resume this attempt." },
};

/** What a person needs to know when the rehearsal stopped for one. */
export function handoverOf(attempt: ReviewerAttempt | null): Handover | null {
  if (attempt?.state !== "waiting-for-person" || !attempt.waitingFor) {
    return null;
  }
  const { reason, since } = attempt.waitingFor;
  const stop = shownRun(attempt).stages.at(-1);
  const { detail, approximated } = unprefixed(reason);
  // The rehearsal files a bot check as a verification step; the page says which.
  const kind =
    stop?.stage === "verification"
      ? /captcha|not a robot/i.test(reason)
        ? "bot-check"
        : "verification"
      : stop?.stage === "consent"
        ? "consent"
        : "other";
  return {
    asked: detail ?? reason,
    approximated,
    frame: frameOf(stop?.evidence?.screenshotArtifactId),
    ...NEXT_STEPS[kind],
    since,
  };
}
