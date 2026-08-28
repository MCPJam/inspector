import type { EvalTraceSpan } from "@/shared/eval-trace";
import { rebaseTraceSpans } from "@/shared/live-chat-trace";

/**
 * The fields of a persisted turn trace this module needs. Structural on
 * purpose — `SharedChatTurnTrace` satisfies it, and tests don't have to build
 * a full row to exercise the rebasing.
 */
export type TurnTraceSpanSource = {
  /** Absolute epoch ms the turn started — the epoch its span offsets are measured from. */
  startedAt: number;
  spansBlobUrl?: string | null;
};

/**
 * Fetch every turn's span blob and flatten them into ONE session timeline.
 *
 * Each turn is traced with its own `createAiSdkEvalTraceContext(turnStartedAt)`
 * (see `runDirectChatTurn`), so the offsets inside a blob are relative to THAT
 * turn — every turn's first span sits at `startMs: 0`. Flattening the blobs
 * without re-anchoring them stacks all turns on top of each other and the
 * timeline renders every span starting at 0.0s (BB-153).
 *
 * So each turn is shifted by its own distance from the session start
 * (`startedAt - sessionStart`), which preserves real wall-clock gaps between
 * turns — the model's think time and any tool latency BETWEEN turns stays
 * visible as empty space, rather than being packed away.
 *
 * The base is the earliest `startedAt` of the turns passed in, so offset 0 is
 * the session start and matches the `traceStartedAtMs` anchor callers compute
 * the same way. Blobs that fail to load contribute nothing and never shift the
 * turns that did load.
 *
 * NOTE: this assumes blobs are turn-relative, which holds for every chat
 * producer (only the eval runner passes an explicit `traceStartedAt`, and eval
 * traces are read through `use-eval-trace-blob`, not here). A chat producer
 * that starts anchoring spans at the session start would double-shift them.
 */
export async function hydrateTurnTraceSpans(
  traces: readonly TurnTraceSpanSource[],
): Promise<EvalTraceSpan[]> {
  if (traces.length === 0) return [];

  // A row with a missing/garbage `startedAt` can't be placed on the timeline;
  // it falls back to offset 0 (today's behaviour) instead of poisoning the base
  // for every other turn with a NaN.
  const startTimes = traces
    .map((trace) => trace.startedAt)
    .filter((startedAt) => Number.isFinite(startedAt));
  const sessionStartedAt = startTimes.length > 0 ? Math.min(...startTimes) : 0;

  const perTurn = await Promise.all(
    traces.map(async (trace) => {
      if (!trace.spansBlobUrl) return [];
      try {
        const response = await fetch(trace.spansBlobUrl);
        if (!response.ok) return [];
        const parsed = await response.json();
        if (!Array.isArray(parsed)) return [];
        const offsetMs = Number.isFinite(trace.startedAt)
          ? trace.startedAt - sessionStartedAt
          : 0;
        return rebaseTraceSpans(parsed as EvalTraceSpan[], offsetMs);
      } catch {
        return [];
      }
    }),
  );

  return perTurn.flat();
}
