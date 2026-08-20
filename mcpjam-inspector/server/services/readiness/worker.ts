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
import { captureServerEventForActor } from "../../utils/analytics.js";
import type { ServerAnalyticsActor } from "../../utils/analytics.js";
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
import {
  redactConformanceReportForSharing,
  type OpenAISubmissionMode,
} from "@mcpjam/sdk";

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
  /**
   * Who the terminal event belongs to, resolved before the request that
   * started this run went away. Absent means the run is not instrumented,
   * which is the honest outcome for a caller with no resolvable identity.
   */
  analyticsActor?: ServerAnalyticsActor;
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
  const startedAtMs = Date.now();

  // SET ON EVERY PATH, EMITTED IN `finally` — including the abandoned-lease
  // path, which is a real outcome worth counting rather than a gap in the
  // data. Recording it at each exit and reporting it in one place is what
  // keeps "this run ended somehow but we have no event for it" impossible.
  let terminal: {
    outcome: string;
    overallStatus?: string;
    observationStatus?: string;
    observationReason?: string;
    terminalReason?: string;
  } = { outcome: "abandoned" };

  // TRACKED SEPARATELY FROM THE ABORT ITSELF. The runner reports every abort
  // as `ReadinessRunCancelledError` — it has no way to inspect a reason — and
  // the catch below treats that as "the lease moved on" and writes nothing.
  // For a genuine cancellation that is right; for a deadline it would strand
  // the row `running` until the recovery cron reclaimed a ten-minute
  // concurrency slot spent on nothing, which is the outcome this function's
  // docblock promises to avoid.
  let deadlineExpired = false;
  const deadline = setTimeout(() => {
    deadlineExpired = true;
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
      // REDACTED ON THE WAY IN, not on the way out.
      //
      // A readiness report is a debugging artifact: findings carry the raw
      // observation behind the verdict, which is how a submitter learns WHY a
      // lane failed. That is the right default while the result lives in the
      // process that produced it, and the wrong one the moment it is persisted
      // — a stored blob outlives the run, is read back by surfaces that did
      // not exist when it was written, and `DirectoryReadinessFinding.details`
      // already documents itself as redacted before it travels.
      //
      // Both layers, deliberately: the key-name pass alone is a blocklist, and
      // a blocklist eventually misses a shape a future check introduces. The
      // structural pass is what makes the blocklist acceptable, by dropping
      // the containers where unknown-shaped secrets actually accumulate before
      // it runs.
      //
      // Defense in depth rather than a breach fix: this route is
      // project-authorized and was never public, and today's evidence is
      // mostly challenges and metadata documents anyone can fetch. The point
      // is that neither of those facts is guaranteed to hold for the next
      // check somebody adds.
      redactConformanceReportForSharing(result),
    );

    terminal = {
      outcome: "completed",
      // The grade, kept separate from the outcome above on purpose: a
      // completed run that graded `not-ready` is a finished run and a failed
      // grade, and one field cannot say both.
      overallStatus: result.status,
      observationStatus: result.llmObservations?.status,
      observationReason: result.llmObservations?.reason,
    };
  } catch (error) {
    if (deadlineExpired) {
      // A run that ran out of time is a FAILED run, and saying so is the whole
      // point: the reason is what tells a reader why they have no report.
      await failReadinessRun(
        lease,
        "deadline_exceeded",
        "The readiness run exceeded its deadline.",
      ).catch(() => undefined);
      terminal = { outcome: "failed", terminalReason: "deadline_exceeded" };
      return;
    }

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
      terminal = { outcome: "abandoned", terminalReason: "lease_lost" };
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
    terminal = { outcome: "failed", terminalReason: "runner_error" };
  } finally {
    clearInterval(heartbeat);
    clearTimeout(deadline);

    // NO REPORT CONTENTS AND NO TARGET URL. What a run found belongs to the
    // person who ran it; what an analytics pipeline needs is whether it
    // finished, what it decided, and whether the paid pass ran.
    if (options.analyticsActor) {
      captureServerEventForActor(
        options.analyticsActor,
        "directory_readiness_run_finished_server",
        {
          readiness_kind: options.publisher,
          submission_mode: options.submissionMode ?? null,
          include_llm_observations: options.includeLlmObservations,
          outcome: terminal.outcome,
          overall_status: terminal.overallStatus ?? null,
          llm_observation_status: terminal.observationStatus ?? null,
          llm_observation_reason: terminal.observationReason ?? null,
          terminal_reason: terminal.terminalReason ?? null,
          duration_ms: Date.now() - startedAtMs,
        },
      );
    }
  }
}
