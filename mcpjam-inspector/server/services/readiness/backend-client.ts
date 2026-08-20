/**
 * The inspector's half of the readiness lease protocol.
 *
 * Four service-token calls against the backend's `/internal/v1/claude-readiness/*`
 * routes: heartbeat, request observations, finalize, fail. The backend already
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
const BROKER_STATUSES: ObservationBrokerAnswer["status"][] = [
  "completed",
  "billing-blocked",
  "provider-failed",
  "invalid-output",
];

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
      } | null;
      const detail =
        typeof body?.error === "string"
          ? body.error
          : `HTTP ${response.status}`;
      return {
        status: "provider-failed",
        reason: "provider_error",
        detail: `the observation broker refused the request: ${detail}`,
      };
    }

    const body = (await response.json().catch(() => null)) as
      | (ObservationBrokerAnswer & { ok?: boolean })
      | null;
    // CONSTRAINED TO THE FOUR STATUSES THIS BUILD KNOWS, not merely to
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
      envelope: body.envelope,
    };
  } finally {
    release();
  }
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
