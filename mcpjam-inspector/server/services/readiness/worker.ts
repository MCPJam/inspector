/**
 * Detached hosted execution for one leased readiness run.
 *
 * ## What this is, and what already existed
 *
 * The backend has owned the durable side of readiness runs for a while:
 * scoped rows, idempotent creation, a claim/lease/heartbeat protocol,
 * cancellation, a recovery cron for dead nodes, blob-backed reports. Nothing
 * consumed it. This is the consumer — the half that actually executes a run
 * while holding the lease, which is why it is net-new code against a protocol
 * that is not.
 *
 * ## The shape, and why it is this shape
 *
 * The v1 start route calls `requestReadinessRun`, gets `{runId, jobId}` back —
 * so the creator holds the lease immediately, with no window in which a run
 * exists that nobody owns — answers `202`, and hands the lease to this module,
 * which runs in-process and detached. Same arrangement the eval routes use for
 * the same reason: a readiness run dials a third party's server and takes
 * longer than any request should be held open.
 *
 * The heartbeat is what makes an in-process detachment safe. A node that dies
 * mid-run stops heartbeating, and the backend's recovery cron re-queues the
 * run with a FRESH job id — so this node coming back from the dead cannot
 * write into the attempt that replaced it. Every write here is job-id guarded
 * on the backend for exactly that reason.
 *
 * ## Cancellation
 *
 * A user who cancels wants the dialling to STOP, not to finish quietly and be
 * discarded. The heartbeat answers `alive: false` once the lease is gone, and
 * that aborts the run in flight — which matters because the thing being
 * stopped is traffic to somebody else's server.
 */

import { logger } from "../../utils/logger.js";
import {
  failReadinessRun,
  finalizeReadinessRun,
  heartbeatReadinessRun,
  requestManagedObservations,
  type ReadinessFinalizeSummary,
  type ReadinessLease,
} from "./backend-client.js";
import {
  ReadinessLeaseLostError,
  ReadinessRunCancelledError,
  runDirectoryReadiness,
  type DirectoryReadinessResult,
  type ReadinessPublisher,
} from "./runner.js";
import type { OpenAISubmissionMode } from "@mcpjam/sdk";

/**
 * How often this node proves it is alive.
 *
 * Comfortably inside the backend's 10-minute lease so an ordinary GC pause or
 * a slow dial cannot look like death, and frequent enough that a cancellation
 * stops the run in seconds rather than minutes — the heartbeat is also the
 * channel a cancellation arrives on.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** A run that has not finished by here is not going to. */
const RUN_DEADLINE_MS = 15 * 60 * 1000;

export interface ExecuteHostedReadinessOptions {
  lease: ReadinessLease;
  publisher: ReadinessPublisher;
  /** From the SAVED project server, never from a worker-supplied URL. */
  target: string;
  submissionMode?: OpenAISubmissionMode;
  headers?: Record<string, string>;
  /** The DNS-pinned transport. */
  fetchFn: typeof fetch;
  /** The requester's opt-in, read off the run row at start. */
  includeLlmObservations: boolean;
  /** The SDK build, stamped onto the row for replay and drift triage. */
  sdkVersion?: string;
}

/** Project the SDK result onto the small summary the run row carries. */
export function summarizeReadinessResult(
  result: DirectoryReadinessResult,
  sdkVersion?: string,
): ReadinessFinalizeSummary {
  const observations = result.llmObservations;
  return {
    overallStatus: result.status,
    lanes: result.lanes.map((lane) => ({
      lane: lane.lane,
      status: lane.status,
      evaluated: lane.coverage.evaluated,
      notEvaluated: lane.coverage.notEvaluated,
      notApplicable: lane.coverage.notApplicable,
      missingInputs: lane.coverage.missingInputs,
    })),
    // Present only for a publisher that HAS staged rollups. Claude has one and
    // already reports it as `overallStatus`; sending an empty array would make
    // the row claim a stage inventory it does not have.
    ...("stages" in result && Array.isArray(result.stages)
      ? {
          stages: result.stages.map((stage) => ({
            stage: stage.stage,
            status: stage.status,
            lanes: stage.lanes,
          })),
        }
      : {}),
    authMode: result.context.authMode,
    capabilities: result.context.capabilities,
    policySnapshotDate: result.policySnapshotDate,
    engineVersion: result.engineVersion,
    sdkVersion,
    llmObservationStatus: observations?.status,
    llmObservationReason: observations?.reason,
    llmObservationDetail: observations?.detail,
  };
}

/**
 * Execute one leased run to a terminal state.
 *
 * NEVER THROWS. Every exit lands the run somewhere terminal — completed,
 * failed, or (when the lease is already gone) deliberately nowhere, because a
 * run this node no longer owns has already been decided by somebody else. A
 * throw that escaped here would strand a `running` row until the recovery
 * cron reclaimed it, which is a ten-minute concurrency slot spent on nothing.
 */
export async function executeHostedReadinessRun(
  options: ExecuteHostedReadinessOptions,
): Promise<void> {
  const { lease } = options;
  const controller = new AbortController();

  const deadline = setTimeout(() => {
    controller.abort(new Error("The readiness run exceeded its deadline."));
  }, RUN_DEADLINE_MS);

  const heartbeat = setInterval(() => {
    void heartbeatReadinessRun(lease).then(({ alive }) => {
      if (alive) return;
      // The lease is gone — cancelled, or swept and re-queued. Aborting stops
      // traffic to somebody else's server for a result nothing will accept.
      logger.info("[readiness] lease lost; aborting run", {
        runId: lease.runId,
      });
      controller.abort(new ReadinessRunCancelledError());
    });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    const { result } = await runDirectoryReadiness({
      publisher: options.publisher,
      target: options.target,
      submissionMode: options.submissionMode,
      headers: options.headers,
      fetchFn: options.fetchFn,
      signal: controller.signal,
      // The requester's opt-in decides whether a requester exists AT ALL. A
      // runner with no requester structurally cannot spend, which is a
      // stronger guarantee than one that checks a flag before asking.
      requestObservations: options.includeLlmObservations
        ? async ({ evidence }) => requestManagedObservations(lease, evidence)
        : undefined,
    });

    await finalizeReadinessRun(
      lease,
      summarizeReadinessResult(result, options.sdkVersion),
      result,
    );
  } catch (error) {
    if (
      error instanceof ReadinessRunCancelledError ||
      error instanceof ReadinessLeaseLostError
    ) {
      // Deliberately terminal-elsewhere. The row was already moved by whoever
      // took the lease away, and writing here would either be rejected on the
      // job-id guard or overwrite a verdict that replaced this one.
      logger.info("[readiness] run abandoned; the lease had moved on", {
        runId: lease.runId,
      });
      return;
    }

    const message =
      error instanceof Error ? error.message : String(error ?? "unknown error");
    logger.error("[readiness] hosted run failed", error, {
      runId: lease.runId,
    });
    await failReadinessRun(lease, "runner_error", message.slice(0, 2000)).catch(
      () => undefined,
    );
  } finally {
    clearInterval(heartbeat);
    clearTimeout(deadline);
  }
}
