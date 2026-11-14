/**
 * The handoff summary and the export pack: what a person or an agent needs to
 * pick a directory submission up from its id alone, and what the team gets at
 * the end of a rehearsal.
 *
 * DERIVED, NEVER STORED. Both are built on every read from the record: the
 * answers, the latest run's findings placed on the flow, the events someone
 * recorded and the labelled snapshots. A summary kept beside the record would
 * drift from it.
 *
 * PICKED, NEVER SPREAD. Every output field is copied by name, so a field an
 * input grows later cannot ride into an export nobody reviewed. A secret
 * appears only as the name of the project secret that holds it, and a
 * finding's raw `details` never appear.
 *
 * Pure. Safe from the browser entry.
 */

import { unconfirmedDeclarations, withDirectoryFlowDefaults } from "./flows/fields.js";
import { directoryVerdict, type DirectoryCheckGate } from "./flows/verdict.js";
import type { DirectoryAnswer, DirectoryEvidenceStatus, DirectoryFlow, PlacedFinding, PlacedStep } from "./flows/types.js";

/** The catalogs "live" can mean, in the order a fix travels. */
export const DIRECTORY_SNAPSHOT_LABELS = ["candidate", "production", "directory", "published"] as const;
export type DirectorySnapshotLabel = (typeof DIRECTORY_SNAPSHOT_LABELS)[number];

/** What happened to a submission outside MCPJam, as someone recorded it. Append-only. */
export interface DirectorySubmissionEvent {
  id: string;
  submissionId: string;
  projectId: string;
  kind: "status" | "snapshot" | "directory-finding" | "credential" | "answer-reset";
  /** Reported: relayed from the directory. Observed: seen first hand. */
  reportedOrObserved: "reported" | "observed";
  /** A status such as `submitted`, or a credential state: `saved`, `tested`, `delivered`. */
  state?: string;
  /** The outcome was unclear, such as a portal dialog that stayed busy. */
  uncertain?: boolean;
  /** The directory's own words for the state, verbatim. */
  directoryLabel?: string;
  detail?: string;
  link?: string;
  /** A confirmation reference the directory gave. */
  reference?: string;
  evidence?: { kind: "url" | "text" | "run"; value: string };
  snapshot?: { label: DirectorySnapshotLabel; serverId: string; revisionNumber?: number; capturedAt?: number; note?: string };
  /** What the directory said, verbatim; never merged with MCPJam's findings. */
  finding?: {
    directory: "claude" | "openai";
    text: string;
    severity?: string;
    code?: string;
    version?: string;
    receivedAt?: number;
    via: "email" | "portal" | "other";
  };
  /** The signed-in principal who recorded it. `actorLabel` is what an agent says it is. */
  actor: string;
  actorLabel?: string;
  createdAt: number;
}

type SnapshotCounts = { tools: number; prompts?: number; resources?: number; resourceTemplates?: number };

/** The latest snapshot under a label, with the revision it names, if any. */
export interface DirectorySubmissionSnapshot extends DirectorySubmissionEvent {
  revision: { revisionNumber: number; capturedAt: number; counts: SnapshotCounts; contractHash: string } | null;
}

export type DirectorySubmissionSnapshots = Record<DirectorySnapshotLabel, DirectorySubmissionSnapshot | null>;

/** Where the real submission lives in the directory, as its submitter recorded it. */
export type DirectorySubmissionRefs = Partial<
  Record<"managementUrl" | "directoryId" | "version" | "confirmationReference", string>
>;

export interface DirectoryHandoffInput {
  flow: DirectoryFlow;
  submission: {
    id: string;
    projectId: string;
    flowVersion: string;
    title?: string;
    serverId?: string;
    revision: number;
    updatedAt: number;
    /** As stored: the flow's defaults are merged in here. */
    answers: readonly DirectoryAnswer[];
    checkGate?: DirectoryCheckGate;
    directoryRefs?: DirectorySubmissionRefs;
  };
  /** Field issues and the latest complete run's findings, by step (`placeDirectoryResults`). */
  results: readonly PlacedStep[];
  /** The run `results` places findings from; `null` before one completes. */
  resultsRunId: string | null;
  /** The submission's newest run, in any state. */
  latestRun: { id: string; status: string; resumable: boolean } | null;
  /** Recorded events of any kind, in any order. */
  events: readonly DirectorySubmissionEvent[];
  snapshots: Partial<DirectorySubmissionSnapshots>;
}

/** Operations a next action may name. A test holds each to MCPJam's operation catalog. */
export type DirectoryHandoffOperation =
  | "update_directory_submission"
  | "start_directory_submission_run"
  | "get_readiness_run"
  | "resume_readiness_run"
  | "diff_server_revisions"
  | "get_directory_submission_finding"
  | "list_directory_submission_findings"
  | "export_directory_submission";

export interface DirectoryNextAction {
  operation: DirectoryHandoffOperation;
  why: string;
  /** The arguments MCPJam knows; `fields` names what the caller adds. */
  input: Record<string, unknown>;
  fields?: string[];
}

/** A step only a person can take, in the directory's own portal. */
export interface DirectoryPortalAction {
  action: "upload" | "connect" | "enter-secret" | "attest" | "submit" | "publish";
  step: string;
  /** The portal's own words: its button, heading or field label. */
  label: string;
  field?: string;
  /** The project secret whose value a person types there; never the value. */
  secretName?: string;
  /** Why it is needed again after the submission. */
  why?: string;
  /** The directory's submission page. */
  url: string;
}

export interface DirectoryUnknown {
  about: "status" | "snapshot" | "check" | "credential";
  /** The snapshot label, check id or field key it concerns. */
  id?: string;
  detail: string;
}

const RECORDED = ["reportedOrObserved", "actor", "actorLabel", "createdAt", "detail", "uncertain"] as const;
const EVIDENCE: readonly DirectoryEvidenceStatus[] = ["established", "inconclusive", "stale", "not-tested", "blocked"];
const COUNTS = ["toFix", "blockers", "likelyFlags", "notChecked", "passed"] as const;
const MAX_BLOCKERS = 10;
/** Statuses after which only publishing is left to do in the portal. */
const WITH_DIRECTORY = new Set(["submitted", "in-review", "approved"]);
/** Portal widgets that stand for an action only a person can take there. */
const WIDGET_ACTIONS: Partial<Record<string, DirectoryPortalAction["action"]>> = {
  upload: "upload",
  connect: "connect",
  "connector-picker": "connect",
  submit: "submit",
  publish: "publish",
};

function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  const picked = {} as Pick<T, K>;
  for (const key of keys) if (value[key] !== undefined) picked[key] = value[key];
  return picked;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function newestFirst(events: readonly DirectorySubmissionEvent[], kind: DirectorySubmissionEvent["kind"]) {
  return events.filter((event) => event.kind === kind).sort((a, b) => b.createdAt - a.createdAt);
}

function statusRecord(event: DirectorySubmissionEvent) {
  return {
    ...pick(event, [...RECORDED, "state", "directoryLabel", "link", "reference"]),
    ...(event.evidence ? { evidence: pick(event.evidence, ["kind", "value"]) } : {}),
  };
}

function snapshotsOf(snapshots: Partial<DirectorySubmissionSnapshots>) {
  const record = (entry: DirectorySubmissionSnapshot | null | undefined) =>
    entry
      ? {
          ...pick(entry, RECORDED),
          ...(entry.snapshot ? pick(entry.snapshot, ["serverId", "revisionNumber", "capturedAt", "note"]) : {}),
          // Absent when no revision is named: what that copy holds is unknown.
          ...(entry.revision && {
            revisionNumber: entry.revision.revisionNumber,
            contractHash: entry.revision.contractHash,
            counts: pick(entry.revision.counts, ["tools", "prompts", "resources", "resourceTemplates"]),
          }),
        }
      : null;
  const latest = Object.fromEntries(
    DIRECTORY_SNAPSHOT_LABELS.map((label) => [label, record(snapshots[label])])
  ) as Record<DirectorySnapshotLabel, ReturnType<typeof record>>;
  // Neighbouring recorded labels whose catalogs differ.
  const known = DIRECTORY_SNAPSHOT_LABELS.filter((label) => latest[label]?.contractHash);
  const differs = known.slice(1).flatMap((to, index) => {
    const from = known[index]!;
    return latest[from]?.contractHash === latest[to]?.contractHash ? [] : [{ from, to }];
  });
  return { latest, differs };
}

type Snapshots = ReturnType<typeof snapshotsOf>;

function countsOf(flow: DirectoryFlow, results: readonly PlacedStep[]) {
  const titles = new Map(flow.steps.map((step) => [step.id, step.title]));
  const steps = results.map(({ step, findings, counts }) => ({
    step,
    title: titles.get(step) ?? step,
    findings: findings.length,
    ...pick(counts, COUNTS),
  }));
  const total = (key: (typeof COUNTS)[number] | "findings") => steps.reduce((sum, entry) => sum + entry[key], 0);
  const placed = results.flatMap((entry) => entry.findings);
  return {
    findings: total("findings"),
    ...(Object.fromEntries(COUNTS.map((key) => [key, total(key)])) as PlacedStep["counts"]),
    byEvidence: Object.fromEntries(
      EVIDENCE.map((status) => [status, placed.filter((entry) => entry.evidenceStatus === status).length])
    ) as Record<DirectoryEvidenceStatus, number>,
    steps,
  };
}

function credentialsOf(input: DirectoryHandoffInput) {
  const stored = new Map(input.submission.answers.map((answer) => [answer.key, answer.value]));
  const events = newestFirst(input.events, "credential");
  const latest = (state: string) => {
    const event = events.find((entry) => entry.state === state);
    return event ? pick(event, RECORDED) : null;
  };
  const secrets = input.flow.steps.flatMap((step) =>
    step.fields
      .filter((field) => field.control === "secret")
      .map(({ key, label }) => {
        const name = stored.get(key);
        return { key, label, secretName: typeof name === "string" && name ? name : null };
      })
  );
  return { secrets, saved: latest("saved"), tested: latest("tested"), delivered: latest("delivered") };
}

type Credentials = ReturnType<typeof credentialsOf>;

/** What only a person can do in the portal, in form order, read from the flow's own layout. */
function portalActionsOf(
  flow: DirectoryFlow,
  state: { status?: string; credentials: Credentials; snapshots: Snapshots }
): DirectoryPortalAction[] {
  const url = flow.submissionUrl;
  const names = new Map(state.credentials.secrets.map((secret) => [secret.key, secret.secretName]));
  // Within a step, what a person fills or ticks comes before the button that ends it.
  const all = flow.steps.flatMap((step) => [
    ...step.fields.flatMap((field): DirectoryPortalAction[] => {
      const base = { step: step.id, field: field.key, label: field.label, url };
      const secretName = names.get(field.key);
      if (field.control === "secret") return [{ action: "enter-secret", ...base, ...(secretName ? { secretName } : {}) }];
      // A ticked statement is the person's to make, in the portal itself.
      const ticked = field.control === "checkbox" || field.control === "checkbox-group";
      return field.declaration && ticked ? [{ action: "attest", ...base }] : [];
    }),
    ...(step.layout?.blocks ?? []).flatMap((block): DirectoryPortalAction[] => {
      const action = WIDGET_ACTIONS[block.widget ?? ""];
      const label = block.text?.button ?? block.text?.submit ?? block.heading ?? step.title;
      return action ? [{ action, step: step.id, label, url }] : [];
    }),
  ]);
  const remaining =
    state.status === "published"
      ? []
      : WITH_DIRECTORY.has(state.status ?? "")
        ? all.filter((entry) => entry.action === "publish")
        : all.filter((entry) => entry.action !== "enter-secret" || !state.credentials.delivered);
  // A fix the directory has not read yet: its copy differs from the one before it.
  const stale = state.snapshots.differs.find((pair) => pair.to === "directory");
  const connect = all.find((entry) => entry.action === "connect");
  if (!stale || !connect) return remaining;
  const refresh = {
    ...connect,
    why: `The ${stale.from} and directory catalogs differ. Reconnect here so the directory reads your tools again, then record a new directory snapshot.`,
  };
  return remaining.includes(connect)
    ? remaining.map((entry) => (entry === connect ? refresh : entry))
    : [...remaining, refresh];
}

function nextActionsOf(
  input: DirectoryHandoffInput,
  state: {
    toAnswer: string[];
    unconfirmed: string[];
    placed: PlacedFinding[];
    /** Every check failing the gate, in form order. */
    blockers: string[];
    /** Ready under the gate, with steps left that only a person can take in the portal. */
    handOver: boolean;
    snapshots: Snapshots;
  }
): DirectoryNextAction[] {
  const { submission, latestRun } = input;
  const project = submission.projectId;
  const scope = { project, submission: submission.id };
  const write = { ...scope, expectedRevision: submission.revision };
  const actions: DirectoryNextAction[] = [];
  const inFlight = latestRun?.status === "pending" || latestRun?.status === "running";
  if (latestRun?.resumable) {
    const why = "The latest run stopped before it finished. Only the person who started it can resume it.";
    actions.push({ operation: "resume_readiness_run", why, input: { project, run: latestRun.id } });
  } else if (latestRun && inFlight) {
    const why = "A run is grading this submission. Read it until it finishes, then read this summary again.";
    actions.push({ operation: "get_readiness_run", why, input: { project, run: latestRun.id } });
  }
  const missing = state.toAnswer.length;
  if (missing > 0) {
    const why = `${plural(missing, "answer")} the portal needs ${missing === 1 ? "is" : "are"} missing or invalid. Send a value for each field.`;
    actions.push({ operation: "update_directory_submission", why, input: write, fields: state.toAnswer });
  }
  if (state.unconfirmed.length > 0) {
    const why =
      "These declarations hold the portal's default or no answer. Ask the person you work for, then confirm each one that is true, or set its value.";
    actions.push({ operation: "update_directory_submission", why, input: write, fields: state.unconfirmed });
  }
  const [first] = state.blockers;
  if (first) {
    const why = "Read what the first blocker found, with its evidence, before you fix it.";
    actions.push({ operation: "get_directory_submission_finding", why, input: { ...scope, check: first } });
  }
  if (state.blockers.length > MAX_BLOCKERS) {
    const why = `${plural(state.blockers.length, "check")} fail the run, and this summary lists the first ${MAX_BLOCKERS}. Page through the violated findings for the rest.`;
    actions.push({ operation: "list_directory_submission_findings", why, input: { ...scope, status: "violated" } });
  }
  const stale = state.placed.filter((entry) => entry.evidenceStatus === "stale").length;
  const blockers = state.blockers.length;
  const rerun = inFlight
    ? undefined
    : input.resultsRunId === null
      ? "No run has graded this submission yet."
      : stale > 0
        ? `${plural(stale, "finding")} read an answer that changed since the run. Run again to recheck them.`
        : blockers > 0
          ? `Run again after fixing the ${plural(blockers, "blocker")} to recheck them.`
          : undefined;
  if (rerun) actions.push({ operation: "start_directory_submission_run", why: rerun, input: scope });
  for (const { from, to } of state.snapshots.differs) {
    const [before, after] = [state.snapshots.latest[from], state.snapshots.latest[to]];
    if (!before?.serverId || before.serverId !== after?.serverId) continue;
    actions.push({
      operation: "diff_server_revisions",
      why: `The ${from} and ${to} catalogs differ. Read which tools changed between them.`,
      input: { project, server: before.serverId, revisionNumber: after.revisionNumber, fromRevisionNumber: before.revisionNumber },
    });
  }
  // Nothing is left in MCPJam: what remains is a person's, in the portal.
  if (state.handOver && !inFlight && missing === 0 && state.unconfirmed.length === 0) {
    const why = "Every gated check passes. Export the pack for the person who finishes in the portal; it lists the steps only they can take there.";
    actions.push({ operation: "export_directory_submission", why, input: { ...scope, format: "markdown" } });
  }
  return actions;
}

function unknownsOf(
  state: { status?: { state?: string; uncertain?: boolean }; credentials: Credentials; snapshots: Snapshots },
  verdict: ReturnType<typeof directoryVerdict>,
  placed: PlacedFinding[]
): DirectoryUnknown[] {
  const unknowns: DirectoryUnknown[] = [];
  const { status, credentials } = state;
  if (!status) {
    const detail = "No status is recorded, so whether this was submitted is unknown. Record one after you submit in the portal.";
    unknowns.push({ about: "status", detail });
  } else if (status.uncertain) {
    const detail = `The latest status, ${status.state}, was recorded as uncertain. Check the portal before you try again.`;
    unknowns.push({ about: "status", detail });
  }
  if (!state.snapshots.latest.directory?.contractHash) {
    const detail = "What the directory holds is unknown until someone records a directory snapshot that names a revision.";
    unknowns.push({ about: "snapshot", id: "directory", detail });
  }
  const reasons = new Map(
    placed.map(({ finding, evidenceStatus }) => [finding.id, (finding.notEvaluatedReason ?? evidenceStatus).replace(/\.$/, "")])
  );
  for (const id of verdict.undetermined) {
    const reason = reasons.get(id) ?? "the run did not report it";
    unknowns.push({ about: "check", id, detail: `It fails the run when violated, and has no current verdict: ${reason}.` });
  }
  for (const id of verdict.notCheckedOnPath) {
    unknowns.push({ about: "check", id, detail: `Not checked on a hosted run: ${verdict.notCheckedReasons[id]}.` });
  }
  for (const { key, label, secretName } of credentials.secrets) {
    if (!secretName) unknowns.push({ about: "credential", id: key, detail: `No project secret is named for ${label}.` });
  }
  if (credentials.secrets.length > 0 && !credentials.tested) {
    const detail = "Nobody has recorded a sign-in with the reviewer credentials, so whether they work is unknown.";
    unknowns.push({ about: "credential", detail });
  }
  return unknowns;
}

export function buildDirectoryHandoff(input: DirectoryHandoffInput) {
  const { flow, submission, results } = input;
  const placed = results.flatMap((step) => step.findings);
  const issues = results.flatMap((step) => step.fieldIssues);
  const verdict = directoryVerdict(placed, { checkGate: submission.checkGate, path: "hosted" });
  const failing = new Set(verdict.failing);
  const blockers = placed.filter((entry) => failing.has(entry.finding.id));
  const unconfirmed = unconfirmedDeclarations(flow, submission.answers);
  const labels = new Map(flow.steps.flatMap((step) => step.fields.map((field) => [field.key, field.reviewLabel ?? field.label])));
  const statusEvent = newestFirst(input.events, "status")[0];
  const status = statusEvent ? statusRecord(statusEvent) : null;
  const credentials = credentialsOf(input);
  const snapshots = snapshotsOf(input.snapshots);
  const state = { status: status ?? undefined, credentials, snapshots };
  const busy = new Set([...issues, ...unconfirmed, ...blockers].map((entry) => entry.step));
  const refs = pick(submission.directoryRefs ?? {}, ["managementUrl", "directoryId", "version", "confirmationReference"]);
  const portal = portalActionsOf(flow, { ...state, status: status?.state });
  return {
    submission: {
      ...pick(submission, ["id", "projectId", "title", "serverId", "revision", "updatedAt", "flowVersion"]),
      flowId: flow.id,
      flowTitle: flow.title,
      directory: flow.directory,
      /** The portal capture the rules come from; `flowVersion` is the one the answers were written to. */
      rulesVersion: flow.version,
      refs,
    },
    /** The latest status someone recorded. MCPJam never sets one itself. */
    status,
    /** The first step, in form order, with something left to do. */
    currentStep: flow.steps.find((step) => busy.has(step.id))?.id ?? null,
    counts: countsOf(flow, results),
    /** The verdict under the submission's gate, which it names. */
    verdict,
    /** The first checks that fail the gate, in form order; `verdict.failing` lists every one. */
    blockers: blockers.slice(0, MAX_BLOCKERS).map(({ finding, step, field }) => ({
      checkId: finding.id,
      ...pick(finding, ["title", "remediation"]),
      step,
      ...(field ? { field } : {}),
    })),
    unconfirmedDeclarations: unconfirmed,
    missingRequired: issues
      .filter((issue) => issue.code === "required")
      .map(({ key, step }) => ({ key, step, label: labels.get(key) ?? key })),
    /** Answers the portal would refuse for a reason other than a missing value. */
    invalidAnswers: issues.filter((issue) => issue.code !== "required").map((issue) => pick(issue, ["key", "step", "code", "message"])),
    credentials,
    snapshots,
    run: { resultsRunId: input.resultsRunId, latest: input.latestRun && pick(input.latestRun, ["id", "status", "resumable"]) },
    nextActions: nextActionsOf(input, {
      toAnswer: [...new Set(issues.map((issue) => issue.key))],
      unconfirmed: unconfirmed.map((declaration) => declaration.key),
      placed,
      blockers: blockers.map((entry) => entry.finding.id),
      handOver: verdict.verdict === "ready" && portal.length > 0,
      snapshots,
    }),
    remainingPortalActions: portal,
    unknowns: unknownsOf(state, verdict, placed),
    links: { submissionUrl: flow.submissionUrl, managementUrl: refs.managementUrl ?? null, statusLink: status?.link ?? null },
  };
}

export type DirectoryHandoff = ReturnType<typeof buildDirectoryHandoff>;

const FINDING = ["title", "lane", "class", "status", "provenance", "remediation", "notEvaluatedReason", "evaluatedAt"] as const;
const DIRECTORY_SAID = ["directory", "text", "severity", "code", "version", "receivedAt", "via"] as const;

/**
 * The pack: the handoff, every answer in form order with who set it, every
 * placed finding without its raw details, what the directory said, and the
 * status history.
 */
export function buildDirectoryExport(input: DirectoryHandoffInput) {
  const { flow } = input;
  const answers = new Map(withDirectoryFlowDefaults(flow, input.submission.answers).map((answer) => [answer.key, answer]));
  return {
    /** What this document is, for a reader holding several JSON files. */
    kind: "mcpjam.directory-submission-export" as const,
    ...buildDirectoryHandoff(input),
    answers: flow.steps.flatMap((step) =>
      step.fields.map((field) => {
        const answer = answers.get(field.key);
        return {
          step: step.id,
          key: field.key,
          label: field.reviewLabel ?? field.label,
          // A secret field holds the NAME of a project secret, never its value.
          value: answer?.value ?? null,
          origin: answer?.origin ?? null,
          ...(field.control === "secret" ? { secret: true as const } : {}),
          ...(answer ? pick(answer, ["setBy", "setByLabel", "setVia", "setAt"]) : {}),
        };
      })
    ),
    findings: input.results.flatMap((step) =>
      step.findings.map((entry) => ({
        checkId: entry.finding.id,
        ...pick(entry, ["step", "field", "evidenceStatus", "staleBecause"]),
        ...pick(entry.finding, FINDING),
      }))
    ),
    directoryFindings: newestFirst(input.events, "directory-finding").flatMap((event) =>
      event.finding ? [{ ...pick(event, RECORDED), ...pick(event.finding, DIRECTORY_SAID) }] : []
    ),
    statusHistory: newestFirst(input.events, "status").map(statusRecord),
  };
}

export type DirectoryExport = ReturnType<typeof buildDirectoryExport>;
