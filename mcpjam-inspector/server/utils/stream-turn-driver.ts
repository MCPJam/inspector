/**
 * Shared stream-turn driver.
 *
 * Both inspector chat engines — the emulated Convex `/stream` loop
 * (`mcpjam-stream-handler.ts`) and the real harness loop
 * (`harness/run-harness-turn.ts`) — independently reconstructed the same
 * per-turn ritual: emit `turn_start`, accumulate trace spans, fire the
 * `onStepFinish` contract (cumulative usage + a defensive `turnSpans` copy +
 * `settledWithError`), gate aborts so a cancelled turn writes no terminal
 * chunk, emit the safety `finish` chunk + `turn_finish`, assemble a
 * `PersistedTurnTrace`, and return a `ChatEngineLoopResult`.
 *
 * This driver owns that ritual so the two engines share one implementation and
 * produce identical live-trace + step-finish semantics. It deliberately does
 * NOT own:
 *   - trace SNAPSHOT cadence — the engines emit `emitTraceSnapshot` at
 *     engine-specific points (harness per step in `finishStep`; emulated
 *     multiple times inside `processOneStep`), so each engine still calls
 *     `emitTraceSnapshot(writer, messages, tools, driver.snapshotContext(...))`
 *     where it needs to;
 *   - span CONSTRUCTION — harness builds synthetic wall-clock llm spans, the
 *     emulated engine builds backend-step spans; each pushes into the shared
 *     `spans` array the driver tracks;
 *   - message/transcript construction — engine-specific (harness hand-builds
 *     MCPJam-shaped messages from `fullStream`; the emulated engine accumulates
 *     `contentParts` per Convex step). The driver only reads the final
 *     `messageHistory` for the result + trace snapshots.
 */
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { FinishReason, UIMessageChunk } from "ai";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { PersistedTurnTrace } from "./chat-ingestion.js";
import {
  getPromptMessageStartIndex,
  writeTraceEvent,
  type LiveTraceSnapshotTurnContext,
} from "./live-chat-trace-stream.js";
import { logger } from "./logger.js";

/** Minimal writer matching `createUIMessageStream`'s `execute` arg + the no-op
 *  (`streamSink: "none"`) writer. */
export type ChunkWriter = { write: (chunk: UIMessageChunk) => void };

export interface UsageTokens {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** The `onStepFinish` payload shape both engines fire (mirrors
 *  `MCPJamStepFinishEvent`). Kept structural so the driver doesn't import the
 *  handler module (avoids a cycle). */
export interface StreamTurnStepFinish {
  stepIndex: number;
  promptIndex: number;
  turnUsage?: UsageTokens;
  settledWithError: boolean;
  turnSpans: EvalTraceSpan[];
}

export interface StreamTurnResult {
  response?: Response;
  messageHistory: ModelMessage[];
  turnTrace?: PersistedTurnTrace;
  aborted: boolean;
}

export interface StreamTurnDriverOptions {
  turnId: string;
  promptIndex: number;
  modelId: string;
  /** Span-offset zero point — set to STREAM start (after setup), so live and
   *  rehydrated traces align. Both engines clock spans from here. */
  traceBaseMs: number;
  /** Shared, hoisted span array the engine pushes into; the driver snapshots
   *  + persists it. */
  spans: EvalTraceSpan[];
  onStepFinish?: (event: StreamTurnStepFinish) => void;
}

/**
 * Owns the per-turn ritual shared by both engines. The engine constructs it
 * once per turn, pushes spans into `driver.spans`, updates `driver.usage`/
 * `driver.finishReason` as the stream settles, and calls the lifecycle methods
 * in its existing order.
 */
export class StreamTurnDriver {
  readonly turnId: string;
  readonly promptIndex: number;
  readonly modelId: string;
  readonly traceBaseMs: number;
  readonly spans: EvalTraceSpan[];

  /** Cumulative per-turn usage (NOT per-step delta); set by the engine as the
   *  stream's `finish`/step usage settles. */
  usage: UsageTokens | undefined;
  finishReason: FinishReason = "stop";

  /** Set true once `turn_start` is emitted, so an error/finish path can avoid
   *  emitting a phantom turn before the stream began. */
  private started = false;
  /** Set true by `finishTurn` on a clean settle; gates persistence. */
  succeeded = false;

  private readonly onStepFinishCb?: (event: StreamTurnStepFinish) => void;

  constructor(opts: StreamTurnDriverOptions) {
    this.turnId = opts.turnId;
    this.promptIndex = opts.promptIndex;
    this.modelId = opts.modelId;
    this.traceBaseMs = opts.traceBaseMs;
    this.spans = opts.spans;
    this.onStepFinishCb = opts.onStepFinish;
  }

  get traceStarted(): boolean {
    return this.started;
  }

  get runSucceeded(): boolean {
    return this.succeeded;
  }

  /** Emit `turn_start`. Call at STREAM start (not function entry) so a
   *  pre-stream failure never creates a phantom turn. */
  emitTurnStart(writer: ChunkWriter): void {
    writeTraceEvent(writer, {
      type: "turn_start",
      turnId: this.turnId,
      promptIndex: this.promptIndex,
      startedAtMs: this.traceBaseMs,
    });
    this.started = true;
  }

  /** Build the snapshot context for `emitTraceSnapshot`. Engines call
   *  `emitTraceSnapshot(writer, messages, tools, driver.snapshotContext(messages))`
   *  at their own cadence. */
  snapshotContext(messageHistory: ModelMessage[]): LiveTraceSnapshotTurnContext {
    return {
      turnId: this.turnId,
      promptIndex: this.promptIndex,
      promptMessageStartIndex: getPromptMessageStartIndex(messageHistory),
      turnSpans: this.spans,
      ...(this.usage ? { turnUsage: this.usage } : {}),
    };
  }

  /**
   * Fire the `onStepFinish` contract: cumulative `turnUsage`, a DEFENSIVE copy
   * of `turnSpans` (callers retain it across step boundaries), and
   * `settledWithError`. Wrapped so a throwing consumer can't crash the loop.
   */
  fireStepFinish(stepIndex: number, settledWithError: boolean): void {
    if (!this.onStepFinishCb) return;
    try {
      this.onStepFinishCb({
        stepIndex,
        promptIndex: this.promptIndex,
        ...(this.usage
          ? {
              turnUsage: {
                inputTokens: this.usage.inputTokens,
                outputTokens: this.usage.outputTokens,
                totalTokens: this.usage.totalTokens,
              },
            }
          : {}),
        settledWithError,
        turnSpans: [...this.spans],
      });
    } catch (error) {
      logger.warn("[stream-turn-driver] onStepFinish callback failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Settle the turn: write the engine-built `finishChunk` (each engine
   * constructs its own — `emitFinish` for harness, `createClientFinishChunk`
   * for emulated), then `turn_finish`, and mark success. The caller is
   * responsible for the silent-abort gate BEFORE calling this.
   */
  finishTurn(
    writer: ChunkWriter,
    opts: { finishChunk?: UIMessageChunk; alreadyEmittedFinish?: boolean }
  ): void {
    if (opts.finishChunk && !opts.alreadyEmittedFinish) {
      writer.write(opts.finishChunk);
    }
    writeTraceEvent(writer, {
      type: "turn_finish",
      turnId: this.turnId,
      promptIndex: this.promptIndex,
      finishReason: this.finishReason,
      ...(this.usage ? { usage: this.usage } : {}),
    });
    this.succeeded = true;
  }

  /** Emit a final snapshot + `turn_finish` on a mid-stream FAILURE (parity
   *  across engines), guarded so a pre-stream failure stays phantom-free. The
   *  snapshot itself is emitted by the caller (engine-specific tools arg);
   *  this only writes `turn_finish`. */
  emitErrorTurnFinish(writer: ChunkWriter): void {
    if (!this.started) return;
    writeTraceEvent(writer, {
      type: "turn_finish",
      turnId: this.turnId,
      promptIndex: this.promptIndex,
      ...(this.usage ? { usage: this.usage } : {}),
    });
  }

  /** Assemble the `PersistedTurnTrace` from the accumulated spans + usage. */
  buildPersistedTrace(): PersistedTurnTrace {
    return {
      turnId: this.turnId,
      startedAt: this.traceBaseMs,
      promptIndex: this.promptIndex,
      endedAt: Date.now(),
      spans: [...this.spans],
      ...(this.usage ? { usage: this.usage } : {}),
      finishReason: this.finishReason,
      modelId: this.modelId,
    };
  }
}
