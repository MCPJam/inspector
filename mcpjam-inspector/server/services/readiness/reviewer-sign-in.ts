/**
 * The reviewer sign-in rehearsal: MCPJam signs in as a directory's reviewer
 * from a clean hosted browser, records each stage on the reviewer attempt,
 * and connects the reviewer account the reviewer-path checks then use.
 *
 * The pages are driven by the playground's browser agent
 * (`reviewer-sign-in-agent.ts`), so a sign-in or consent page nobody wrote a
 * rule for, such as an organization choice, is handled like any other. The
 * credentials, the desktop with its agent, the connection request and the
 * attempt arrive as seams, so every stage, and the release after it, is
 * testable without E2B, a model or the backend. The live seams are built in
 * `reviewer-sign-in-live.ts`.
 *
 * THE DESKTOP IS RELEASED ON EVERY OUTCOME, in a `finally`, including a
 * thrown error and a lost lease: MCPJam pays for it by the minute.
 *
 * NO CREDENTIAL IS WRITTEN DOWN. A value reaches the browser daemon only
 * beside a command whose text is its `{{secret:NAME}}` placeholder, limited to
 * the authorization server's origin, and only on a daemon that enforces that
 * limit (`secret-origins`). Text from the page, the agent or an error is
 * scrubbed of the values before it is recorded or logged, and keeps only the
 * origin of a URL.
 *
 * MCPJAM DECIDES SUCCESS. Only the redirect to MCPJam's callback, caught by
 * the browser, leads to a connection; the agent's own report never does. The
 * signed-in identity is never read from a page: the identity check asks the
 * server itself.
 */
import { createSecretScrubber } from "../../../shared/secret-scrubber.js";
import { redactForLog } from "../../routes/v1/redact-log-message.js";
import { logger } from "../../utils/logger.js";
import { BROWSERD_PUBLIC_NETWORK_FEATURE } from "../browserd/protocol.js";
import { abortable } from "../sessionSimulation/target-discovery.js";
import type {
  SignInAgent,
  SignInAgentOutcome,
} from "./reviewer-sign-in-agent.js";
import { ReadinessLeaseLostError } from "./runner.js";

export type ReviewerStageName =
  | "credentials"
  | "connect-link"
  | "sign-in"
  | "verification"
  | "consent"
  | "connected"
  | "identity";

/** One stage, in the shape the attempt's run route takes it. */
export interface ReviewerStage {
  stage: ReviewerStageName;
  status: "passed" | "failed" | "blocked" | "skipped";
  detail?: string;
  evidence?: {
    screenshotArtifactId?: string;
    /** Whether the stage's own picture was taken, and if not, why. */
    screenshotStatus?: "captured" | "suppressed" | "unavailable";
    screenshotNote?: string;
    recordingArtifactId?: string;
  };
}

/** One write to the attempt. A stop for a person and an outcome are exclusive. */
export interface ReviewerAttemptWrite {
  stage?: ReviewerStage;
  reviewerAccountId?: string;
  waitingFor?: { reason: string; action: string };
  outcome?: "passed" | "failed";
  detail?: string;
  /** The one password try: marked before the value leaves this node. */
  passwordSubmission?: { commandId: string; outcome: "intent" | "not_typed" };
}

/** The attempt as the rehearsal reads it: secret NAMES, never a value. */
export interface ReviewerAttemptView {
  projectId: string;
  reviewerAccountId?: string;
  humanSignInCompletedAt?: number;
  passwordSecretName: string;
  usernameSecretName?: string;
  username?: string;
  /** Where the reviewer signs in, when the submitter saved it. */
  loginUrl?: string;
  /** The organization or tenant the reviewer must end up signed in to. */
  tenant?: string;
}

export interface ReviewerConnectLink {
  authorizationUrl: string;
  /** The one origin the reviewer's credentials may be typed on. */
  authorizationServerOrigin: string;
  /** MCPJam's callback page, where the authorization server sends the answer. */
  callbackUrl: string;
}

export interface ReviewerCallback {
  state: string;
  code?: string;
  iss?: string;
  error?: string;
  errorDescription?: string;
}

export interface ReviewerSignInDeps {
  /** Lease-guarded writes to the attempt; a lost lease throws. */
  record(write: ReviewerAttemptWrite): Promise<void>;
  /** The values for these names, or why they cannot be had. */
  secrets(
    names: string[],
  ): Promise<
    { values: { name: string; value: string }[] } | { unavailable: string }
  >;
  desktop: {
    /** A clean desktop and the agent that drives it. */
    reserve(signal: AbortSignal): Promise<{ agent: SignInAgent }>;
    /** Release the desktop. Safe to call again. */
    release(): Promise<void>;
  };
  connect: {
    prepare(signal: AbortSignal): Promise<ReviewerConnectLink>;
    complete(
      callback: ReviewerCallback,
      signal: AbortSignal,
    ): Promise<{ accountId: string } | { failed: string }>;
  };
}

export type ReviewerSignInOutcome =
  | {
      kind: "connected";
      reviewerAccountId: string;
      /** A person finished it through the handoff link; MCPJam did not sign in. */
      signedInBy?: "person";
    }
  | { kind: "failed"; detail: string }
  | { kind: "waiting-for-person"; reason: string; action: string };

/** Desktop boot, discovery, a two-step sign-in and consent fit well inside. */
export const REVIEWER_SIGN_IN_TIMEOUT_MS = 6 * 60_000;
const START_AGAIN = "Start a new attempt.";
const PERSON_SIGN_IN =
  "Open Finish reviewer sign-in on the submission, complete the sign-in, then resume this attempt.";

type Scrub = (text: string) => string;

/** The last write, and what the run learns. */
interface Ending {
  write: ReviewerAttemptWrite;
  outcome: ReviewerSignInOutcome;
}

/** End the attempt as failed or, given an `action`, stop it for a person. */
function ending(stage: ReviewerStage, action?: string): Ending {
  const detail = stage.detail ?? "";
  if (action) {
    const waitingFor = { reason: detail, action };
    return {
      write: { stage, waitingFor },
      outcome: { kind: "waiting-for-person", ...waitingFor },
    };
  }
  return {
    write: { stage, outcome: "failed", detail },
    outcome: { kind: "failed", detail },
  };
}

/** Values back to placeholders, and of any URL only its origin. */
function scrubberFor(values: { name: string; value: string }[]): Scrub {
  const scrubber = createSecretScrubber(values, {
    replacement: (name) => `{{secret:${name}}}`,
  });
  return (text) =>
    (scrubber ? scrubber.scrubString(text) : text).replace(
      /\bhttps?:\/\/[^\s"'<>)]+/gi,
      originOf,
    );
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "[address]";
  }
}

/** An error as one scrubbed sentence. */
const said = (error: unknown, scrub: Scrub) =>
  scrub(redactForLog(error)).replace(/[.\s]*$/, ".");

interface Drive {
  deps: ReviewerSignInDeps;
  signal: AbortSignal;
  scrub: Scrub;
}

/** A stage the run writes itself; the agent's stages carry their pictures. */
const stageOf = (
  stage: ReviewerStageName,
  status: ReviewerStage["status"],
  detail: string,
): ReviewerStage => ({ stage, status, detail });

const record = (drive: Drive, stage: ReviewerStage) =>
  abortable(
    drive.deps.record({
      stage: {
        ...stage,
        ...(stage.detail ? { detail: drive.scrub(stage.detail) } : {}),
      },
    }),
    drive.signal,
  );

/** Hand what the redirect carried to the connection; the URL goes nowhere. */
async function finishConnect(
  drive: Drive,
  params: URLSearchParams,
): Promise<Ending> {
  const param = (key: string) => params.get(key) || undefined;
  const state = param("state");
  if (!state) {
    return ending(
      stageOf(
        "connected",
        "failed",
        `The reviewer account was not connected because MCPJam's callback page did not receive the authorization result. ${START_AGAIN}`,
      ),
    );
  }
  const callback = {
    state,
    code: param("code"),
    iss: param("iss"),
    error: param("error"),
    errorDescription: param("error_description"),
  };
  const answer = await abortable(
    drive.deps.connect.complete(callback, drive.signal),
    drive.signal,
  );
  if ("failed" in answer) {
    const why = drive.scrub(answer.failed).replace(/[.\s]*$/, ".");
    return ending(
      stageOf(
        "connected",
        "failed",
        `The reviewer account was not connected. ${why} ${START_AGAIN}`,
      ),
    );
  }
  const detail =
    "MCPJam signed in as the reviewer and connected the reviewer account.";
  return {
    write: {
      stage: stageOf("connected", "passed", detail),
      reviewerAccountId: answer.accountId,
    },
    outcome: { kind: "connected", reviewerAccountId: answer.accountId },
  };
}

/** What a person does next, by where the agent stopped. */
const PERSON_ACTION: Record<string, string> = {
  verification:
    "Open Finish reviewer sign-in on the submission, complete the verification, then resume this attempt.",
  consent:
    "Open Finish reviewer sign-in on the submission, approve access, then resume this attempt.",
};

/** The agent's ending, as the attempt records it: never a pass. */
function agentEnding(
  drive: Drive,
  outcome: Exclude<SignInAgentOutcome, { kind: "callback" }>,
): Ending {
  const reason = drive.scrub(outcome.reason).replace(/[.\s]*$/, ".");
  const evidence = outcome.evidence ? { evidence: outcome.evidence } : {};
  if (outcome.kind === "stopped" && !outcome.needsPerson) {
    return ending({
      stage: outcome.stage,
      status: "failed",
      detail: `MCPJam's browser agent stopped: ${reason} Check the saved credentials and tenant, then ${START_AGAIN.toLowerCase()}`,
      ...evidence,
    });
  }
  const stopped =
    outcome.kind === "stopped"
      ? `The sign-in reached a step MCPJam's browser agent cannot finish: ${reason}`
      : `MCPJam's browser agent stopped before MCPJam's callback: ${reason}`;
  return ending(
    { stage: outcome.stage, status: "blocked", detail: stopped, ...evidence },
    PERSON_ACTION[outcome.stage] ?? PERSON_SIGN_IN,
  );
}

/** Reserve, check, connect and drive; the caller releases. */
async function rehearse(
  deps: ReviewerSignInDeps,
  base: {
    attempt: ReviewerAttemptView;
    values: { name: string; value: string }[];
    signal: AbortSignal;
    scrub: Scrub;
  },
): Promise<Ending> {
  const { signal, scrub } = base;
  let link: ReviewerConnectLink;
  try {
    link = await abortable(deps.connect.prepare(signal), signal);
  } catch (error) {
    if (error instanceof ReadinessLeaseLostError || signal.aborted) throw error;
    return ending({
      stage: "connect-link",
      status: "failed",
      detail: `MCPJam could not prepare the reviewer's connection: ${said(error, scrub)} ${START_AGAIN}`,
    });
  }
  const blocked = (detail: string) =>
    ending({ stage: "sign-in", status: "blocked", detail }, PERSON_SIGN_IN);
  let reserved: Awaited<ReturnType<ReviewerSignInDeps["desktop"]["reserve"]>>;
  try {
    reserved = await abortable(deps.desktop.reserve(signal), signal);
  } catch (error) {
    if (error instanceof ReadinessLeaseLostError || signal.aborted) throw error;
    return blocked(
      `MCPJam could not get a hosted browser for the sign-in: ${said(error, scrub)} No password was entered by this run.`,
    );
  }
  const { agent } = reserved;
  // The submitter's pages decide where the browser goes, so it must not reach
  // the box's loopback, cloud metadata or a private network.
  if (!agent.features.includes(BROWSERD_PUBLIC_NETWORK_FEATURE)) {
    return ending({
      stage: "connect-link",
      status: "blocked",
      detail:
        "This hosted browser cannot keep the sign-in to public internet addresses, so MCPJam did not open the sign-in page.",
    }, PERSON_SIGN_IN);
  }
  if (!agent.features.includes("secret-origins")) {
    return blocked(
      "This hosted browser cannot limit the reviewer's credentials to the sign-in page, so MCPJam did not type them.",
    );
  }
  // Without a stop at MCPJam's callback, its app would take the code before
  // this run could read it, so nothing is started.
  if (!agent.features.includes("navigation-stop-persistent")) {
    return ending({
      stage: "connected",
      status: "blocked",
      detail:
        "This hosted browser cannot stop at MCPJam's callback page, so MCPJam could not finish the reviewer's connection and did not sign in.",
    }, PERSON_SIGN_IN);
  }
  const drive: Drive = { deps, signal, scrub };
  const outcome = await agent.run({
    link,
    attempt: base.attempt,
    values: base.values,
    signal,
    record: (stage) => record(drive, stage),
  });
  return outcome.kind === "callback"
    ? finishConnect(drive, new URL(outcome.url).searchParams)
    : agentEnding(drive, outcome);
}

/** Write the last stage with the outcome; a lost lease still throws. */
async function end(
  deps: ReviewerSignInDeps,
  result: Ending,
  scrub: Scrub,
): Promise<ReviewerSignInOutcome> {
  try {
    await deps.record(result.write);
  } catch (error) {
    if (error instanceof ReadinessLeaseLostError) throw error;
    // The attempt was cancelled or taken over meanwhile; what this run
    // learned still decides how it goes on.
    logger.warn("[readiness] the sign-in outcome was not recorded", {
      error: said(error, scrub),
    });
  }
  return result.outcome;
}

/**
 * Rehearse the reviewer's sign-in for a run that joined `attempt`.
 *
 * Throws only for a lost lease or the caller's own abort: every other failure
 * becomes a recorded stage and a `failed` outcome, and the run goes on to
 * grade the submission without the reviewer account.
 */
export async function rehearseReviewerSignIn(
  deps: ReviewerSignInDeps,
  attempt: ReviewerAttemptView,
  options: { signal: AbortSignal; timeoutMs?: number },
): Promise<ReviewerSignInOutcome> {
  const timeoutMs = options.timeoutMs ?? REVIEWER_SIGN_IN_TIMEOUT_MS;
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(timeoutMs),
  ]);
  const names = [attempt.usernameSecretName, attempt.passwordSecretName].filter(
    (name): name is string => name !== undefined,
  );
  const secrets = await deps.secrets(names);
  if ("unavailable" in secrets) {
    const stage = { stage: "credentials", status: "blocked" } as const;
    const scrub = scrubberFor([]);
    const detail = scrub(secrets.unavailable);
    return end(deps, ending({ ...stage, detail }), scrub);
  }
  const scrub = scrubberFor(secrets.values);
  let result: Ending;
  try {
    result = await rehearse(deps, {
      attempt,
      values: secrets.values,
      signal,
      scrub,
    });
  } catch (error) {
    if (error instanceof ReadinessLeaseLostError || options.signal.aborted) {
      throw error;
    }
    const why = signal.aborted
      ? `The sign-in did not finish within ${Math.round(timeoutMs / 60_000)} minutes.`
      : `The sign-in stopped on an error: ${said(error, scrub)}`;
    result = ending({
      stage: "sign-in",
      status: "failed",
      detail: `${why} ${START_AGAIN}`,
    });
  } finally {
    try {
      await deps.desktop.release();
    } catch (error) {
      // The backend also releases a run's desktop when the run ends or is
      // re-queued, so a failed release costs minutes, not a leaked box.
      logger.warn("[readiness] releasing the sign-in desktop failed", {
        error: said(error, scrub),
      });
    }
  }
  return end(deps, result, scrub);
}
