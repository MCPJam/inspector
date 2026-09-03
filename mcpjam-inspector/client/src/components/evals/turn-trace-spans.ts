import { evalTraceSpanZ, type EvalTraceSpan } from "@/shared/eval-trace";
import { rebaseTraceSpans } from "@/shared/live-chat-trace";

/**
 * Validate a blob's spans, dropping the rows that fail rather than the blob.
 *
 * These blobs are remote JSON the client does not control, and a bad number in
 * ONE of them is not contained to its own turn: `trace-timeline` computes
 * `maxEndMs` as `reduce((max, s) => Math.max(max, s.endMs), 1)`, and
 * `Math.max(x, NaN)` is `NaN` — which then propagates into `axisMaxMs` and the
 * zoom bounds for every turn on the timeline. The cast this replaces let that
 * through untouched.
 *
 * `Number.isFinite` on top of the schema on purpose: zod's `z.number()` rejects
 * `NaN` but ACCEPTS `Infinity`, and an infinite `endMs` wrecks the axis just as
 * thoroughly.
 */
function parseTraceSpans(parsed: readonly unknown[]): EvalTraceSpan[] {
  const spans: EvalTraceSpan[] = [];
  for (const candidate of parsed) {
    const result = evalTraceSpanZ.safeParse(candidate);
    if (!result.success) continue;
    if (
      !Number.isFinite(result.data.startMs) ||
      !Number.isFinite(result.data.endMs)
    ) {
      continue;
    }
    spans.push(result.data as EvalTraceSpan);
  }
  return spans;
}

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
 * The base is the earliest FINITE `startedAt` of the turns passed in, so offset
 * 0 is the session start. `ShareUsageThreadDetail` — the one caller that
 * computes a wall-clock anchor — filters the same way, so span positions and
 * axis labels share an origin even when a row carries a garbage `startedAt`.
 * Blobs that fail to load contribute nothing and never shift the turns that did
 * load.
 *
 * Turn-relative is an assumption, not a guarantee, which is why
 * `sessionAnchored` exists. It holds for every chat producer, but NOT for the
 * eval runner: `drive-local-eval-turn` passes `traceStartedAt: runStartedAt`,
 * so eval spans are already measured from the run start, while the per-turn
 * rows `persist-eval-trace` fans out stamp `turnStartedAt` with a fresh
 * `Date.now()` per row. Shifting those by `startedAt - sessionStart` would
 * displace them by the accumulated persist round-trip, so an eval thread must
 * pass `sessionAnchored: true` and keep the offsets its blobs already carry.
 */
export async function hydrateTurnTraceSpans(
  traces: readonly TurnTraceSpanSource[],
  options?: {
    /**
     * The blobs already share ONE origin, so no per-turn shift is applied.
     * True for eval threads; false (the default) for every chat producer,
     * whose blobs each restart at `startMs: 0`.
     */
    sessionAnchored?: boolean;
  },
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
        const spans = parseTraceSpans(parsed);
        if (spans.length === 0) return [];
        const offsetMs =
          options?.sessionAnchored || !Number.isFinite(trace.startedAt)
            ? 0
            : trace.startedAt - sessionStartedAt;
        return rebaseTraceSpans(spans, offsetMs);
      } catch {
        return [];
      }
    }),
  );

  return perTurn.flat();
}
