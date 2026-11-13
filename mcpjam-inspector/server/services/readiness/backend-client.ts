import {
  DIRECTORY_OBSERVATION_STATUSES,
  type DirectoryAnswer,
} from "@mcpjam/sdk";
/**
 * The inspector's half of the readiness lease protocol.
 *
 * Six service-token calls against the backend's `/internal/v1/claude-readiness/*`
 * routes: claim, heartbeat, request observations, read the frozen submission
 * answers, finalize, fail. The backend already
 * owns the durable side — claim, lease, recovery, retention — and nothing here
 * duplicates it; this is the client a worker holds while it executes.
 *
 * TWO RULES SHAPE EVERY FUNCTION HERE.
 *
 * The `jobId` accompanies every call, because a service token proves only that
 * an inspector node is calling. Which node currently owns THIS run is a
 * separate question, and the answer is the lease. A node swept by recovery and
 * then resurrected must not be able to write into the attempt that replaced it
 * — including, especially, an observation call that would spend money.
 *
 * A heartbeat that answers `alive: false` is a STOP signal, not a warning. The
 * lease is gone — the run was cancelled or swept — and continuing would dial a
 * third party's server for a result nothing will accept.
 */

import {
  getInternalBackendConfig,
  isEntityNotFound,
} from "../internal-backend.js";
import { backendFailureText } from "../../utils/backend-failure-text.js";
import { isOrgKeyPolicyRefusalCode } from "../../../shared/ai-execution-refusal.js";
import {
  ReadinessLeaseLostError,
  type ObservationBrokerAnswer,
} from "./runner.js";

// Re-exported so a caller that only holds the client does not have to reach
// past it for the error the client throws.
export { ReadinessLeaseLostError };

const READINESS_PATH = "/internal/v1/claude-readiness/runs";
const OBSERVATIONS_PATH = "/internal/v1/claude-readiness/observations";

/**
 * The statuses this build understands, as a runtime list.
 *
 * A closed check rather than `typeof === "string"`, because the value lands on
 * the run row and a surface branches on it.
 */
const BROKER_STATUSES = DIRECTORY_OBSERVATION_STATUSES.filter(
  (status): status is ObservationBrokerAnswer["status"] =>
    status !== "not-requested" && status !== "pending",
);

/** Per-call budget. Generous for the report, tight for the heartbeat. */
const HEARTBEAT_TIMEOUT_MS = 10_000;
const INGEST_TIMEOUT_MS = 60_000;
/** The broker calls a provider, so its ceiling is the provider's plus a margin. */
const OBSERVATION_TIMEOUT_MS = 90_000;

/**
 * One service-token POST, with a deadline that outlives the headers.
 *
 * The caller gets back a `release` it must call once the BODY is consumed.
 * Clearing the timer in a `finally` around `fetch` alone would end the
 * deadline the moment the response headers arrived — and a backend that
 * answers and then stalls mid-body would leave the caller's `response.json()`
 * with no bound at all, quietly turning the heartbeat's ten-second budget into
 * an unbounded wait.
 */
async function postInternal(
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ response: Response; release: () => void }> {
  const { convexUrl, serviceToken } = getInternalBackendConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const release = () => clearTimeout(timer);
  try {
    const response = await fetch(`${convexUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-inspector-service-token": serviceToken,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { response, release };
  } catch (error) {
    release();
    throw error;
  }
}

export interface ReadinessLease {
  runId: string;
  jobId: string;
}

/** The backend's reasons to refuse a claim. Each one means: do not execute. */
const CLAIM_REFUSALS = ["already_claimed", "lease_lost", "not_found"] as const;
export type ReadinessClaimRefusal = (typeof CLAIM_REFUSALS)[number];

export type ReadinessClaim =
  | { status: "claimed" }
  | { status: "refused"; reason: ReadinessClaimRefusal }
  | { status: "unanswered"; detail: string };

const CLAIM_TIMEOUT_MS = 10_000;

export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    // Not JSON: a backend without the route answers with its router's text.
    return null;
  }
}

/**
 * Take the run this node just created, `pending` to `running`, on the lease it
 * already holds and before anything dials.
 *
 * A REFUSAL STOPS THE RUN: it is already running (`already_claimed`), it was
 * cancelled or re-queued (`lease_lost`), or it does not exist (`not_found`).
 *
 * NO ANSWER DOES NOT. An unreachable backend, a 5xx, or a backend that
 * predates the claim route answers `unanswered`, and the worker executes as it
 * did before claims existed: the row stays `pending`, and every heartbeat and
 * write is still checked against the lease. Stopping there would leave a
 * fresh run waiting for recovery and then for its requester to resume it.
 */
export async function claimReadinessRun(
  lease: ReadinessLease,
): Promise<ReadinessClaim> {
  try {
    const { response, release } = await postInternal(
      `${READINESS_PATH}/claim`,
      lease,
      CLAIM_TIMEOUT_MS,
    );
    try {
      const body = parseJsonObject(await response.text());
      if (response.ok && body?.claimed === true) return { status: "claimed" };
      const reason = CLAIM_REFUSALS.find((refusal) => refusal === body?.error);
      if (!response.ok && reason) return { status: "refused", reason };
      return { status: "unanswered", detail: `HTTP ${response.status}` };
    } finally {
      release();
    }
  } catch (error) {
    return {
      status: "unanswered",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tell the backend this node is still alive, and learn whether it still owns
 * the run.
 *
 * NEVER THROWS on a transport failure, and reports `alive: true` when it
 * cannot tell. A network blip between two healthy machines must not abort a
 * run that is going perfectly well — the backend's own recovery cron is what
 * eventually reclaims a genuinely dead node, and it measures the heartbeat
 * rather than trusting this call's opinion. Failing closed here would mean a
 * flaky link killing good runs, which is a worse outcome than a dead node
 * living for one extra lease period.
 */
export async function heartbeatReadinessRun(
  lease: ReadinessLease,
): Promise<{ alive: boolean }> {
  try {
    const { response, release } = await postInternal(
      `${READINESS_PATH}/heartbeat`,
      lease,
      HEARTBEAT_TIMEOUT_MS,
    );
    try {
      if (!response.ok) {
        // The body is never read on this path, and an unread body holds its
        // keep-alive connection until GC. Cancelling hands it back now.
        await response.body?.cancel().catch(() => undefined);
        return { alive: true };
      }
      const body = (await response.json().catch(() => null)) as {
        alive?: unknown;
      } | null;
      return { alive: body?.alive !== false };
    } finally {
      release();
    }
  } catch {
    return { alive: true };
  }
}

/**
 * Ask the backend broker for model observations.
 *
 * EVERY FAILURE THAT IS NOT A LOST LEASE BECOMES AN ANSWER, not an exception.
 * The observation pass is optional and non-dispositive, so a broker outage
 * must leave the deterministic run intact — a thrown error here would fail a
 * readiness grade over a feature the caller could have skipped entirely.
 *
 * A lost lease is the exception, and it is the right one: it means this node
 * has no business writing anything for this run, so the worker should stop
 * rather than continue toward a finalize that will be rejected.
 */
export async function requestManagedObservations(
  lease: ReadinessLease,
  evidence: string,
): Promise<ObservationBrokerAnswer> {
  let posted: { response: Response; release: () => void };
  try {
    posted = await postInternal(
      OBSERVATIONS_PATH,
      { ...lease, observationKind: "experience", evidence },
      OBSERVATION_TIMEOUT_MS,
    );
  } catch (error) {
    return {
      status: "provider-failed",
      reason: "provider_error",
      detail:
        error instanceof Error
          ? `the observation broker could not be reached: ${error.message}`
          : "the observation broker could not be reached",
    };
  }

  const { response, release } = posted;
  try {
    if (response.status === 409) throw new ReadinessLeaseLostError();
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: unknown;
        code?: unknown;
      } | null;
      const detail = backendFailureText({
        source: "readiness-observations",
        status: response.status,
        detail: body?.error,
        fallback: `HTTP ${response.status}`,
      });
      // The organization requires its own provider keys and cannot serve this
      // pass: a configuration state ("Not analyzed"), not a provider outage.
      // Read off the code, never the prose.
      if (
        typeof body?.code === "string" &&
        isOrgKeyPolicyRefusalCode(body.code)
      ) {
        return {
          status: "ai-unavailable",
          reason: "ai_unavailable",
          refusalCode: body.code.trim().toLowerCase(),
          detail: `the organization's AI configuration could not run the observation pass (${body.code.trim().toLowerCase()}): ${detail}`,
        };
      }
      return {
        status: "provider-failed",
        reason: "provider_error",
        detail: `the observation broker refused the request: ${detail}`,
      };
    }

    const body = (await response.json().catch(() => null)) as
      | (ObservationBrokerAnswer & { ok?: boolean })
      | null;
    // Constrained to the statuses this build knows, not merely to
    // "a string". The value is copied onto the run row as
    // `llmObservationStatus`, so a backend deployed ahead of this build could
    // otherwise persist a status the SDK never defined — the exact drift the
    // envelope re-validation exists to catch, arriving through the one field
    // that was not being checked.
    if (!body || !BROKER_STATUSES.includes(body.status as never)) {
      return {
        status: "provider-failed",
        reason: "provider_error",
        detail: "the observation broker returned an unreadable body",
      };
    }
    return {
      status: body.status,
      reason: body.reason,
      detail: body.detail,
      refusalCode: body.refusalCode,
      envelope: body.envelope,
    };
  } finally {
    release();
  }
}

/** The answers a run grades, frozen when the run was requested. */
export interface ReadinessRunSubmission {
  submissionId: string;
  submissionRevision: number;
  flowId: string;
  flowVersion: string;
  answers: DirectoryAnswer[];
}

/** The run names a submission whose frozen answers could not be read. */
export class ReadinessSubmissionUnreadableError extends Error {
  readonly code = "readinessSubmissionUnreadable" as const;
}

const SUBMISSION_TIMEOUT_MS = 10_000;

function isRunSubmission(body: unknown): body is ReadinessRunSubmission {
  const inputs = body as Partial<ReadinessRunSubmission> | null;
  return (
    typeof inputs?.submissionId === "string" &&
    typeof inputs.submissionRevision === "number" &&
    typeof inputs.flowId === "string" &&
    typeof inputs.flowVersion === "string" &&
    Array.isArray(inputs.answers) &&
    inputs.answers.every(
      (answer) =>
        typeof answer?.key === "string" && typeof answer.origin === "string",
    )
  );
}

/**
 * Read the copy of the submission's answers made in the same mutation that
 * created this run, so answers edited while it waited are the next run's.
 *
 * Every failure but a lost lease throws `ReadinessSubmissionUnreadableError`:
 * a run must fail with the reason rather than grade an empty form, which
 * would report every required field as missing. The message lands on the run
 * row, so it is written for the person reading the run.
 */
export async function getReadinessRunSubmission(
  lease: ReadinessLease,
): Promise<ReadinessRunSubmission> {
  const { convexUrl, serviceToken } = getInternalBackendConfig();
  const query = new URLSearchParams({ runId: lease.runId, jobId: lease.jobId });
  let response: Response;
  let body: unknown;
  try {
    // `AbortSignal.timeout` stays armed through the body read as well. Read
    // on every status, so a refusal's body does not hold its connection.
    response = await fetch(`${convexUrl}${READINESS_PATH}/submission?${query}`, {
      headers: { "x-inspector-service-token": serviceToken },
      signal: AbortSignal.timeout(SUBMISSION_TIMEOUT_MS),
    });
    const text = await response.text();
    body = response.ok ? JSON.parse(text) : undefined;
  } catch (error) {
    throw new ReadinessSubmissionUnreadableError(
      "This run's saved answers could not be read, so it was not graded. Start the run again.",
      { cause: error },
    );
  }
  if (response.status === 409) throw new ReadinessLeaseLostError();
  if (response.status === 404) {
    throw new ReadinessSubmissionUnreadableError(
      "This run's saved answers were not found, so it was not graded. Start a new run from the submission.",
    );
  }
  if (!response.ok || !isRunSubmission(body)) {
    throw new ReadinessSubmissionUnreadableError(
      `This run's saved answers could not be read (HTTP ${response.status}), so it was not graded. Start the run again.`,
    );
  }
  // Picked, so the body's `ok` flag and anything the route gains later stay out of the report.
  const { submissionId, submissionRevision, flowId, flowVersion, answers } =
    body;
  return { submissionId, submissionRevision, flowId, flowVersion, answers };
}

/** The small, indexed summary the run row carries. The report is opaque. */
export interface ReadinessFinalizeSummary {
  overallStatus: "ready" | "not-ready" | "incomplete";
  lanes: {
    lane: string;
    status: "ready" | "not-ready" | "incomplete";
    evaluated: number;
    notEvaluated: number;
    notApplicable: number;
    missingInputs: string[];
  }[];
  stages?: {
    stage: string;
    status: "ready" | "not-ready" | "incomplete";
    lanes: string[];
  }[];
  authMode: "headless" | "interactive" | "provided-token";
  capabilities: string[];
  policySnapshotDate: string;
  engineVersion: string;
  sdkVersion?: string;
  llmObservationStatus?: string;
  llmObservationReason?: string;
  llmObservationDetail?: string;
}

/**
 * Store the report and mark the run completed, in one call.
 *
 * The blob can only be stored from inside Convex, so the report goes over this
 * route and the route stores it and finalizes the row in the same breath —
 * which is also what lets the backend delete an orphaned blob when the lease
 * has moved on. Nothing else knows that blob id exists.
 */
export async function finalizeReadinessRun(
  lease: ReadinessLease,
  summary: ReadinessFinalizeSummary,
  report: unknown,
): Promise<{ applied: boolean }> {
  const { response, release } = await postInternal(
    READINESS_PATH,
    { ...lease, ...summary, report },
    INGEST_TIMEOUT_MS,
  );
  try {
    if (response.status === 413) {
      await response.body?.cancel().catch(() => undefined);
      // A report over the ingestion cap is a FAILED run rather than a lost one:
      // recording the reason is what tells a reader why they have no report,
      // where silence reads as a node that vanished.
      await failReadinessRun(
        lease,
        "report_too_large",
        "The readiness report exceeded the ingestion size limit.",
      ).catch(() => undefined);
      return { applied: false };
    }
    if (!response.ok) {
      if (await isEntityNotFound(response, "not_found"))
        return { applied: false };
      throw new Error(`Readiness finalize failed (${response.status})`);
    }
    const body = (await response.json().catch(() => null)) as {
      applied?: unknown;
    } | null;
    return { applied: body?.applied === true };
  } finally {
    release();
  }
}

export async function failReadinessRun(
  lease: ReadinessLease,
  terminalReason: string,
  errorMessage?: string,
): Promise<{ applied: boolean }> {
  const { response, release } = await postInternal(
    READINESS_PATH,
    { ...lease, outcome: "failed", terminalReason, errorMessage },
    INGEST_TIMEOUT_MS,
  );
  try {
    if (!response.ok) {
      // The body is never read on this path, and an unread body holds its
      // keep-alive connection until GC. Cancelling hands it back now — the
      // same reason the heartbeat and finalize paths do it.
      await response.body?.cancel().catch(() => undefined);
      return { applied: false };
    }
    const body = (await response.json().catch(() => null)) as {
      applied?: unknown;
    } | null;
    return { applied: body?.applied === true };
  } finally {
    release();
  }
}
