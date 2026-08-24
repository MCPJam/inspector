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
import { uploadVideoBlob } from "../../utils/mcp-app-widget-capture.js";
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
import { buildIterationMetadata } from "./iteration-metadata.js";
import {
  buildHostIterationMetadata,
  type HostExecutionPolicy,
  type ToolExposureSignals,
} from "@mcpjam/sdk/host-config/internal";
import {
  deriveStageResults,
  stageDerivationToMetadata,
  type EvalSuiteFileToolPolicy,
  type StageAuthoredCase,
  type StageSetupSignals,
} from "@mcpjam/sdk/contract";
import {
  lockEvalSessionAfterUpdate,
  persistEvalTraceFanout,
} from "./persist-eval-trace.js";

type IterationStatus = "completed" | "failed" | "cancelled";

type ToolCallRecord = { toolName: string; arguments: Record<string, any> };
type PolicyBlockRecord = { reason?: unknown };

/**
 * Stage derivation uses the first recorded block as the stable iteration
 * summary reason when multiple policy blocks occur.
 */
function getIterationPolicyReason(
  policyBlocks: ReadonlyArray<PolicyBlockRecord>
): string | undefined {
  const reason = policyBlocks[0]?.reason;
  return typeof reason === "string" ? reason : undefined;
}

/**
 * Adapt what the runner captured into the analyzer's evidence shape.
 *
 * The only subtle part is the two "we have no spans" flags, which are NOT
 * interchangeable and which the analyzer reports differently:
 *
 *   - `traceAbsent` — nothing was captured at all. The row exists (a setup
 *     failure, a lifecycle stop) and carries no transcript.
 *   - `traceLacksSpanChannel` — a transcript exists (messages and/or per-turn
 *     summaries) but no spans. That is the caller-supplied `HostExecutor`
 *     signature: the run DID happen and this executor simply never reports
 *     what happened. Collapsing it into "nothing happened" is precisely how a
 *     run with every tool call failing passes vacuously.
 */
function buildStageEvidence(args: {
  spans?: EvalTraceSpan[];
  prompts?: PromptTraceSummary[];
  messages?: ModelMessage[];
  predicateResults?: unknown[];
  widgetRenderObservations?: RunnerWidgetRenderObservation[];
  /**
   * Pinned (model-free) tool-call failures. These never enter the trace — the
   * same blind spot `buildEvalIterationVerdict` compensates for when it applies
   * `failOnToolError` to them explicitly — so without them a pinned tool
   * failure would leave `call`/`response` looking unmeasured.
   */
  toolErrors?: unknown[];
  toolSignals?: ToolExposureSignals;
  setupSignals?: StageSetupSignals;
}) {
  const hasSpans = (args.spans?.length ?? 0) > 0;
  const hasPrompts = (args.prompts?.length ?? 0) > 0;
  const hasMessages = (args.messages?.length ?? 0) > 0;
  return {
    ...(hasSpans ? { spans: args.spans } : {}),
    ...(hasPrompts ? { prompts: args.prompts } : {}),
    ...(args.predicateResults?.length
      ? {
          predicateResults: args.predicateResults as ReadonlyArray<{
            passed?: boolean;
            reason?: string;
          }>,
        }
      : {}),
    ...(args.widgetRenderObservations?.length
      ? { renderObservations: args.widgetRenderObservations }
      : {}),
    ...(args.toolErrors?.length
      ? {
          toolErrors: args.toolErrors as ReadonlyArray<{
            kind?: string;
            toolName?: string;
          }>,
        }
      : {}),
    ...(args.toolSignals ? { toolSignals: args.toolSignals } : {}),
    ...(args.setupSignals ? { setupSignals: args.setupSignals } : {}),
    traceAbsent: !hasSpans && !hasPrompts && !hasMessages,
    traceLacksSpanChannel: !hasSpans && (hasPrompts || hasMessages),
  };
}

/**
 * Derive one iteration's user-value chain metadata, or `{}` when the caller
 * cannot say what the case authored.
 *
 * Exported because a SETUP ABORT never reaches `buildIterationFinishParams`:
 * `persistSetupFailedIteration` writes its own minimal row for an iteration
 * that threw before the prompt loop started. That is exactly the shape the
 * chain has a dedicated verdict for — every applicable stage `notMeasured` for
 * `setupAborted`, `failureCategory: "setup"` — so leaving that path out would
 * file a case that demonstrably died in setup as having no chain at all, which
 * reads identically to an old SDK that reports no chain. Both callers derive
 * through here so the two cannot drift.
 */
export function buildStageMetadata(args: {
  stageCase?: StageAuthoredCase;
  spans?: EvalTraceSpan[];
  prompts?: PromptTraceSummary[];
  messages?: ModelMessage[];
  predicateResults?: unknown[];
  widgetRenderObservations?: RunnerWidgetRenderObservation[];
  stageToolErrors?: unknown[];
  toolSignals?: ToolExposureSignals;
  setupSignals?: StageSetupSignals;
  policy?: { blocked: boolean; reason?: string };
  status: "completed" | "failed";
  error?: string;
}): Record<string, unknown> {
  const { stageCase, status, error } = args;
  if (!stageCase) return {};
  return stageDerivationToMetadata(
    deriveStageResults({
      authored: stageCase,
      evidence: buildStageEvidence({
        spans: args.spans,
        prompts: args.prompts,
        messages: args.messages,
        predicateResults: args.predicateResults,
        widgetRenderObservations: args.widgetRenderObservations,
        toolErrors: args.stageToolErrors,
        toolSignals: args.toolSignals,
        setupSignals: args.setupSignals,
      }),
      iteration: { status, ...(error ? { error } : {}) },
      policy: args.policy,
    }),
  );
}

/**
 * Builds the `finishParams` object every runner passes to
 * {@link finalizeIterationWithBrowserArtifacts} (which adds `videoBytes` +
 * `convexClient` and dispatches to the recorder or `finalizeEvalIteration`).
 *
 * PR3 of the runner unification (plan: we-need-robustness-and-jaunty-toast.md):
 * the four runners built this object inline, identical in shape but with
 * per-runner variable names. Centralizing it removes the drift risk. The
 * `error`/`errorDetails` fields are normalized to omit-when-absent (the local
 * runners' shape); this is cosmetic for persisted output because
 * `finalizeEvalIteration` forwards both to Convex unconditionally anyway (see
 * invariant #7 in the plan), so the golden Convex-payload snapshots are
 * unchanged.
 */
export function buildIterationFinishParams(args: {
  iterationId: string | undefined;
  passed: boolean;
  /** `evaluation` drives both `toolsCalled` and `buildIterationMetadata`. */
  evaluation: { toolsCalled: ToolCallRecord[] } & Record<string, unknown>;
  usage: UsageTotals;
  messages: ModelMessage[];
  /** The model selected for this iteration, used for session attribution. */
  modelId?: string;
  systemPrompt?: string;
  spans?: EvalTraceSpan[];
  prompts?: PromptTraceSummary[];
  widgetSnapshots?: EvalTraceWidgetSnapshot[];
  widgetRenderObservations?: RunnerWidgetRenderObservation[];
  browserInteractionSteps?: RunnerBrowserInteractionStep[];
  status: "completed" | "failed";
  startedAt: number;
  error?: string;
  errorDetails?: string;
  /** Case-level + per-turn predicate results; persisted to metadata.predicates. */
  predicateResults?: unknown[];
  /** Fail-fast skipped steps (PR6); persisted to metadata.skippedSteps. */
  skippedSteps?: unknown[];
  /**
   * One verdict row per authored step (`buildStepResultRecords`); persisted to
   * `metadata.stepResults`. The clean per-step contract the public `/steps` API
   * projects — `stepId`-keyed status+reason for every kind, where the lossy
   * `predicates` rows lack `stepId` and interact failures aren't otherwise saved.
   */
  stepResults?: unknown[];
  /**
   * The authored case's stage-applicability inputs, from
   * `buildStageAuthoredCase`.
   *
   * PRESENT ⇒ this iteration gets a derived user-value chain under
   * `metadata.stageResults` (+ `firstFailedStage` / `failureCategory` /
   * `stageAnalyzerVersion`). ABSENT ⇒ no stage keys are written at all, which
   * is the honest default for a caller that cannot say what the case authored:
   * without the authored case there is no way to tell `notApplicable` from
   * `notMeasured`, and guessing would report a stage the case never exercised
   * as an evidence gap.
   *
   * Threaded as its own argument rather than folded into
   * `iterationMetadataBase` because `buildIterationMetadata` is typed
   * scalar-only (`Record<string, string | number | boolean>`) and
   * `stageResults` is an array of rows.
   */
  stageCase?: StageAuthoredCase;
  /**
   * Pinned tool-call failures, for the stage derivation only (the verdict
   * gates on them separately). Never enter the trace, so the chain is blind to
   * them unless they are threaded here.
   */
  stageToolErrors?: unknown[];
  /** Execution-layer policy blocks; persisted as metadata, never a failure. */
  policyBlocks?: PolicyBlockRecord[];
  /** Non-fatal policy configuration warnings, persisted for run consumers. */
  policyWarnings?: string[];
  /**
   * The effective tool policy this iteration executed under, snapshotted the
   * same way `hostPolicy` evidence is: the run row has no field to carry it
   * (a backend `toolPolicy` column is Lane B), so without this snapshot a
   * REPLAY of a policied run cannot reconstruct the policy — and a replay
   * re-dials the ORIGINAL servers with the original credentials
   * (`MCPServerReplayConfig`), so an unreconstructed policy means the calls we
   * blocked run for real the second time.
   */
  toolPolicy?: EvalSuiteFileToolPolicy;
  iterationMetadataBase: Record<string, string | number | boolean>;
  hostPolicy?: HostExecutionPolicy;
  toolSignals?: ToolExposureSignals;
  /**
   * Folded run-level connect / tools-list evidence. Threaded into the
   * analyzer; the same signals are also persisted under
   * `metadata.stageSetupAudit.signals` (see `setupAudit`) so a v2 verdict
   * can be audited or recomputed.
   */
  setupSignals?: StageSetupSignals;
  /**
   * Synthetic connection/discovery spans. Persisted on the trace (timeline)
   * but never enter stage-derivation evidence.
   */
  setupSpans?: EvalTraceSpan[];
  /** Bounded canary/audit extras from the run-setup observer. */
  setupAudit?: Record<string, unknown>;
  injectOpenAiCompat?: boolean;
}): Omit<FinalizeEvalIterationParams, "convexClient" | "videoBytes"> {
  const {
    iterationId,
    passed,
    evaluation,
    usage,
    messages,
    modelId,
    systemPrompt,
    spans,
    prompts,
    widgetSnapshots,
    widgetRenderObservations,
    browserInteractionSteps,
    status,
    startedAt,
    error,
    errorDetails,
    predicateResults,
    skippedSteps,
    stepResults,
    stageCase,
    stageToolErrors,
    policyBlocks,
    policyWarnings,
    toolPolicy,
    iterationMetadataBase,
    hostPolicy,
    toolSignals,
    setupSignals,
    setupSpans,
    setupAudit,
    injectOpenAiCompat,
  } = args;
  const persistedSpans = [
    ...(setupSpans ?? []),
    ...(spans ?? []),
  ];
  const stageMetadata = buildStageMetadata({
    ...(stageCase ? { stageCase } : {}),
    spans,
    prompts,
    messages,
    predicateResults,
    widgetRenderObservations,
    stageToolErrors,
    toolSignals,
    setupSignals,
    policy:
      policyBlocks &&
      policyBlocks.length > 0 &&
      !error &&
      !(stageToolErrors && stageToolErrors.length > 0)
        ? {
            blocked: true,
            reason: getIterationPolicyReason(policyBlocks),
          }
        : undefined,
    status,
    ...(error ? { error } : {}),
  });
  return {
    iterationId,
    passed,
    toolsCalled: evaluation.toolsCalled,
    usage,
    messages,
    ...(modelId ? { modelId } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(persistedSpans.length ? { spans: persistedSpans } : {}),
    ...(prompts?.length ? { prompts } : {}),
    ...(widgetSnapshots?.length ? { widgetSnapshots } : {}),
    ...(widgetRenderObservations?.length ? { widgetRenderObservations } : {}),
    ...(browserInteractionSteps?.length ? { browserInteractionSteps } : {}),
    status,
    startedAt,
    ...(error ? { error } : {}),
    ...(errorDetails ? { errorDetails } : {}),
    resultSource: "reported" as const,
    metadata: {
      ...iterationMetadataBase,
      ...buildIterationMetadata(evaluation as never),
      ...(predicateResults?.length ? { predicates: predicateResults } : {}),
      ...(skippedSteps?.length ? { skippedSteps } : {}),
      ...(stepResults?.length ? { stepResults } : {}),
      ...(policyBlocks?.length
        ? {
            policyBlocks,
            policyBlockCount: policyBlocks.length,
          }
        : {}),
      ...(policyWarnings?.length ? { policyWarnings } : {}),
      ...(toolPolicy ? { toolPolicy } : {}),
      ...stageMetadata,
      ...(setupAudit ?? {}),
      ...(hostPolicy && toolSignals
        ? buildHostIterationMetadata(
            hostPolicy,
            toolSignals,
            evaluation.toolsCalled.length,
            injectOpenAiCompat === true,
          )
        : {}),
    },
  };
}

const DEFAULT_ITERATION_STATUS: IterationStatus = "completed";

export type FinalizeEvalIterationParams = {
  convexClient: ConvexHttpClient;
  iterationId?: string;
  passed: boolean;
  toolsCalled: Array<{ toolName: string; arguments: Record<string, any> }>;
  usage: UsageTotals;
  messages: ModelMessage[];
  /** Effective model used by the iteration; persisted on the eval session. */
  modelId?: string;
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
  /**
   * Iteration replay `.webm` bytes from the harness (`browser.collectVideo()`).
   * Uploaded ONCE here (same Convex-storage path as screenshots) → `videoBlobId`
   * forwarded to the W2 fanout and the W1 fallback. Best-effort: a failed upload
   * is logged and dropped — the iteration still finalizes. One video per
   * iteration, so this is iteration-level, not per-turn.
   */
  videoBytes?: Buffer | null;
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
    modelId,
    spans,
    prompts,
    widgetSnapshots,
    systemPrompt,
    widgetRenderObservations,
    browserInteractionSteps,
    videoBytes,
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

  // Check if the iteration is already in a terminal stop state before trying
  // to update. A timed-out iteration whose original LLM/browser work ignores
  // the abort and completes late must NOT overwrite the `timed_out` row with a
  // completed/failed result — both `cancelled` and `timed_out` are terminal.
  try {
    const iteration = await convexClient.query(
      "testSuites:getTestIteration" as any,
      { iterationId },
    );
    if (
      iteration?.status === "cancelled" ||
      iteration?.status === "timed_out"
    ) {
      logger.debug(
        "[evals] Skipping update for terminal iteration:",
        iterationId,
        iteration.status,
      );
      return;
    }
  } catch {
    // If we can't check status, continue anyway.
  }

  const iterationStatus =
    status ?? (passed ? DEFAULT_ITERATION_STATUS : "failed");
  const result = passed ? "passed" : "failed";

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
      : isCycleFailure
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

  // Upload the iteration replay video alongside the screenshots, in the same
  // single-pass choke point. Best-effort: a failed upload is logged + dropped
  // (videoBlobId stays undefined → no player) and NEVER fails the iteration.
  let videoBlobId: string | undefined;
  if (videoBytes && videoBytes.length > 0) {
    try {
      videoBlobId = await uploadVideoBlob(convexClient, videoBytes);
    } catch (err) {
      logger.warn("[evals] replay video upload failed; finalizing without it", {
        iterationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const fanout = await persistEvalTraceFanout({
    convexClient,
    iterationId,
    iterationStartedAt: startedAt,
    messages,
    ...(modelId ? { modelId } : {}),
    spans,
    prompts,
    widgetSnapshots,
    systemPrompt,
    widgetRenderObservations: serializedWidgetRenderObservations,
    browserInteractionSteps: serializedBrowserInteractionSteps,
    ...(videoBlobId ? { videoBlobId } : {}),
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
            // Iteration replay video already uploaded above; carry the storageId
            // onto the W1 fallback so the replay survives the fanout-failed path.
            ...(videoBlobId ? { videoBlobId } : {}),
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
