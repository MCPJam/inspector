import type { ModelMessage } from "ai";
import type { ConvexHttpClient } from "convex/browser";
import type {
  EvalTraceSpan,
  EvalTraceWidgetSnapshot,
  PromptTraceSummary,
  RunnerBrowserInteractionStep,
  RunnerWidgetRenderObservation,
} from "@/shared/eval-trace";
import { logger } from "../../utils/logger.js";
import type { UsageTotals } from "./types.js";
import { sanitizeForConvexTransport } from "./convex-sanitize.js";
import { emitBrowserEvalMetrics } from "./browser-eval-metrics.js";
import {
  serializeBrowserStepsForBackend,
  serializeRenderObservationsForBackend,
  toBrowserStepPayload,
  toObservationPayload,
} from "./finalize-iteration-browser-artifacts.js";
import { buildIterationUsageMetadata } from "./iteration-usage-metadata.js";
import {
  lockEvalSessionAfterUpdate,
  persistEvalTraceFanout,
} from "./persist-eval-trace.js";

type IterationStatus = "completed" | "failed" | "cancelled" | "timed_out";

const DEFAULT_ITERATION_STATUS: IterationStatus = "completed";

export type FinalizeEvalIterationParams = {
  convexClient: ConvexHttpClient;
  iterationId?: string;
  passed: boolean;
  toolsCalled: Array<{ toolName: string; arguments: Record<string, any> }>;
  usage: UsageTotals;
  messages: ModelMessage[];
  spans?: EvalTraceSpan[];
  prompts?: PromptTraceSummary[];
  widgetSnapshots?: EvalTraceWidgetSnapshot[];
  /**
   * Resolved system prompt for the eval session. Forwarded to
   * `persistEvalTraceFanout` → `appendEvalTurnTrace.systemPrompt`,
   * which the backend persists to `chatSessions.systemPrompt` with
   * first-write-wins semantics. Also forwarded on the W1 fallback
   * `updateTestIteration` call so the prompt lands even when the
   * fanout failed before any turn wrote.
   */
  systemPrompt?: string;
  /**
   * PR 6b: browser-rendered MCP App eval artifacts collected by the runner
   * (runner-local shape, screenshots still base64). Serialized ONCE here —
   * screenshots uploaded, records sanitized — then forwarded to the W2 fanout
   * and reused on the W1 fallback so neither path re-uploads.
   */
  widgetRenderObservations?: RunnerWidgetRenderObservation[];
  browserInteractionSteps?: RunnerBrowserInteractionStep[];
  status?: IterationStatus;
  startedAt?: number;
  error?: string;
  errorDetails?: string;
  resultSource?: "reported" | "derived";
  // Scalar signals (argumentMismatchCount, host exposure counts, …) plus the
  // nested `predicates: PredicateResult[]` rows. Persisted to
  // `testIteration.metadata`; the Convex validator accepts nested values.
  metadata?: Record<string, unknown>;
  /**
   * Recorder hook: called when the iteration update returns a
   * "not found" / "unauthorized" / "cancelled" error so the caller can
   * short-circuit further calls on this run. Direct callers (no recorder)
   * pass nothing.
   */
  onRunDeleted?: () => void;
};

/**
 * Shared finalize step for both the multi-iteration suite-run recorder
 * (`SuiteRunRecorder.finishIteration`) and the quick-run direct path
 * (where `runId === null`). Owns:
 *   - early bail when there is no `iterationId`
 *   - cancellation pre-check via `getTestIteration`
 *   - status / result / terminalReason derivation
 *   - per-turn fanout via `persistEvalTraceFanout`
 *   - W1 single-call fallback (`messages` + optional trace fields) when
 *     the fanout failed before any turn landed
 *   - `updateTestIteration` call with sanitized metadata
 *   - terminal lock via `lockEvalSessionAfterUpdate` (post-update)
 *
 * The two paths used to be near byte-identical (`recorder.ts` vs
 * `evals-runner.ts:finishIterationDirectly`). The systemPrompt-slot PR
 * series (mcpjam-backend #448 + #449, inspector #2481) had to fix the
 * same W1 fallback bug — `systemPrompt` was dropped — in BOTH paths.
 * This collapse prevents the next instance of that bug class.
 *
 * Suite-run-scoped state (the recorder's `runDeleted` short-circuit
 * flag) stays in the recorder; it surfaces here as the `onRunDeleted`
 * callback fired in the same error branches the recorder used to flip
 * `runDeleted` in directly.
 */
export async function finalizeEvalIteration(
  params: FinalizeEvalIterationParams,
): Promise<void> {
  const {
    convexClient,
    iterationId,
    passed,
    toolsCalled,
    usage,
    messages,
    spans,
    prompts,
    widgetSnapshots,
    systemPrompt,
    widgetRenderObservations,
    browserInteractionSteps,
    status,
    startedAt,
    error,
    errorDetails,
    resultSource,
    metadata,
    onRunDeleted,
  } = params;

  if (!iterationId) {
    return;
  }

  // Check if iteration was cancelled before trying to update.
  try {
    const iteration = await convexClient.query(
      "testSuites:getTestIteration" as any,
      { iterationId },
    );
    if (iteration?.status === "cancelled" || iteration?.status === "timed_out") {
      logger.debug(
        "[evals] Skipping update for terminal iteration:",
        iterationId,
      );
      return;
    }
  } catch {
    // If we can't check status, continue anyway.
  }

  const iterationStatus =
    status ?? (passed ? DEFAULT_ITERATION_STATUS : "failed");
  const result =
    iterationStatus === "timed_out"
      ? "timed_out"
      : passed
        ? "passed"
        : "failed";

  // PR-2 eval→chatSessions fanout: write the transcript as per-turn rows
  // BEFORE calling updateTestIteration. The fanout no longer fires the
  // terminal lock — that happens AFTER updateTestIteration succeeds so
  // a downstream iteration-row failure cannot leave a locked transcript
  // without a finalized iteration (PR-2 review fix #2, Cursor
  // #ed44ef40). Idempotent on retry.
  //
  // Fanout result drives whether we still pass trace fields to
  // updateTestIteration:
  //   - persisted:true  → trace lives in chatSessions; updateTestIteration
  //                       called WITHOUT trace fields (no double-persist)
  //   - persisted:false → fanout failed before any turn landed; fall
  //                       back to the legacy single-call path so the
  //                       iteration is still complete and replayable.
  //
  // lockReason describes the transcript LIFECYCLE (did the eval cycle
  // run to completion?), NOT the verdict. A failed-verdict iteration
  // that ran cleanly (status: "completed", result: "failed") still gets
  // eval_completed; eval_failed is reserved for cycle failures like
  // provider errors, MCP transport crashes, etc. The verdict lives on
  // testIteration.result (passed | failed | pending).
  //
  // The `error != null` check covers a runner quirk (Codex review on
  // #2446): the backend eval paths sometimes set `iterationError` while
  // still calling finishIteration with `status: "completed"` (see
  // evals-runner.ts). Treating those as eval_completed would lock an
  // error transcript with the wrong reason. Presence of `error` is the
  // cycle-failure signal we already have in scope.
  const isCycleFailure =
    iterationStatus === "failed" || (error !== undefined && error !== "");
  const terminalReason: "eval_completed" | "eval_failed" | "eval_cancelled" =
    iterationStatus === "cancelled"
      ? "eval_cancelled"
      : iterationStatus === "timed_out" || isCycleFailure
        ? "eval_failed"
        : "eval_completed";

  // PR 13: emit per-iteration browser-eval observability from the runner-local
  // arrays (covers both the stream + non-stream paths via this shared choke
  // point). Best-effort + no-op when the iteration didn't touch the harness.
  emitBrowserEvalMetrics(widgetRenderObservations, browserInteractionSteps);

  // PR 6b: serialize browser artifacts ONCE here (upload screenshots + run
  // through the convex sanitizer) so the W2 fanout and the W1 fallback share a
  // single upload pass. Owning this in the shared finalize step is what keeps
  // recorder + direct quick-run callers from double-uploading.
  const serializedWidgetRenderObservations =
    await serializeRenderObservationsForBackend(
      widgetRenderObservations,
      convexClient,
    );
  const serializedBrowserInteractionSteps =
    await serializeBrowserStepsForBackend(
      browserInteractionSteps,
      convexClient,
    );

  const fanout = await persistEvalTraceFanout({
    convexClient,
    iterationId,
    iterationStartedAt: startedAt,
    messages,
    spans,
    prompts,
    widgetSnapshots,
    systemPrompt,
    widgetRenderObservations: serializedWidgetRenderObservations,
    browserInteractionSteps: serializedBrowserInteractionSteps,
  });
  // Fall back to the W1 single-call path ONLY when the fanout failed
  // before any turn landed. With turns already written, re-sending
  // would overwrite turn 0 (W1 always writes at promptIndex: 0) and
  // orphan turns 1..N. See persist-eval-trace.ts for the contract.
  const useW1Fallback =
    fanout.persisted === false && fanout.turnsWritten === 0;
  if (fanout.persisted === false) {
    logger.warn(
      useW1Fallback
        ? "[evals] persistEvalTraceFanout failed before any turn landed; falling back to W1 single-call save"
        : "[evals] persistEvalTraceFanout failed mid-stream; iteration finalized without re-attempting (would orphan partial turns)",
      {
        iterationId,
        turnsWritten: fanout.turnsWritten,
        error: fanout.error.message,
      },
    );
  }

  // PR-2 review #5 (Cursor "Update failure after successful fanout"):
  // track whether the iteration is gone so we don't waste a lock
  // call on a deleted session, AND so the lock fires even when
  // the iteration update threw a transient error.
  let iterationGoneOrCancelled = false;
  try {
    await convexClient.action("testSuites:updateTestIteration" as any, {
      iterationId,
      status: iterationStatus === "completed" ? "completed" : iterationStatus,
      result,
      actualToolCalls: sanitizeForConvexTransport(toolsCalled),
      tokensUsed: usage.totalTokens ?? 0,
      ...(useW1Fallback
        ? {
            messages: sanitizeForConvexTransport(messages),
            // Mirrors `appendEvalTurnTrace.systemPrompt`. Cursor Bugbot
            // follow-up "W1 omits systemPrompt": without this the W1
            // fallback persists a transcript with no resolved system
            // prompt — the prepend was dropped earlier in the
            // systemPrompt-slot PR series. Backend `updateTestIteration`
            // accepts the slot (mcpjam-backend #449); first-write-wins
            // semantics apply, no risk of clobbering a value already
            // set by an earlier `appendEvalTurnTrace`.
            ...(systemPrompt ? { systemPrompt } : {}),
            ...(spans?.length
              ? { spans: sanitizeForConvexTransport(spans) }
              : {}),
            ...(prompts?.length
              ? { prompts: sanitizeForConvexTransport(prompts) }
              : {}),
            ...(widgetSnapshots?.length
              ? {
                  widgetSnapshots:
                    sanitizeForConvexTransport(widgetSnapshots),
                }
              : {}),
            // PR 6b: browser artifacts already uploaded + sanitized above;
            // strip `promptIndex` (the backend stamps it from the W1 turn's
            // promptIndex: 0). All artifacts land under that single fallback
            // turn — lossy but acceptable, mirroring W1's transcript fallback.
            ...(serializedWidgetRenderObservations.length
              ? {
                  widgetRenderObservations:
                    serializedWidgetRenderObservations.map(
                      toObservationPayload,
                    ),
                }
              : {}),
            ...(serializedBrowserInteractionSteps.length
              ? {
                  browserInteractionSteps:
                    serializedBrowserInteractionSteps.map(toBrowserStepPayload),
                }
              : {}),
          }
        : {}),
      error,
      errorDetails,
      resultSource,
      // Merge user-provided metadata with token usage breakdown, then
      // sanitize: metadata can carry nested predicate rows whose
      // authored args may contain $-prefixed keys Convex rejects at
      // the boundary.
      metadata: sanitizeForConvexTransport({
        ...(metadata ?? {}),
        ...buildIterationUsageMetadata(usage),
      }),
    });
  } catch (caught) {
    const errorMessage =
      caught instanceof Error ? caught.message : String(caught);

    // Check if run was deleted/not found or iteration was cancelled.
    if (
      errorMessage.includes("not found") ||
      errorMessage.includes("unauthorized") ||
      errorMessage.includes("cancelled")
    ) {
      iterationGoneOrCancelled = true;
      onRunDeleted?.();
    } else {
      logger.error(
        "[evals] Failed to record iteration result:",
        new Error(errorMessage),
      );
      // Transient (non-cancellation) failure: fall through to the lock
      // step. The chatSessions transcript is complete from the fanout's
      // perspective; locking prevents a retry from accumulating partial
      // writes against a row whose data already represents the final
      // state. The iteration row's terminal status remains stale until
      // a retry/cron sweep finalizes it — that's acceptable because
      // the data is consistent at the chatSessions layer.
    }
  }

  // Lock the chatSession when fanout succeeded — runs in BOTH the
  // success branch (updateTestIteration succeeded → defense + UI hint)
  // and the transient-failure branch (updateTestIteration threw a
  // non-cancellation error → prevents partial writes on retry).
  // Skipped only when the iteration is gone, where locking a deleted
  // session is wasted work. Best-effort: lockEvalSessionAfterUpdate
  // swallows its own failures.
  if (fanout?.persisted === true && !iterationGoneOrCancelled) {
    await lockEvalSessionAfterUpdate({
      convexClient,
      iterationId,
      reason: terminalReason,
    });
  }
}
