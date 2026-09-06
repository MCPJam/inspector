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
 * 0 is the session start. {@link turnTraceWallClockRange} — which every caller
 * uses for its axis anchor — filters the same way, so span positions and axis
 * labels share an origin even when a row carries a garbage `startedAt`. Blobs
 * that fail to load contribute nothing and never shift the turns that did load.
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

/**
 * What both persisted-trace readers say when the recorded spans are gone.
 *
 * One string on purpose: the swarm pane and the User Testing / Sessions detail
 * are two views of the same session, and a viewer who sees this in one place
 * and different wording in the other has to work out whether it is the same
 * problem.
 *
 * It has to name the CONSEQUENCE, because the timeline underneath contradicts
 * it otherwise. Neither reader passes `estimatedDurationMs`, so the viewer
 * cannot fall back to an estimated timeline — `mode` lands on `"none"` and it
 * prints "No timing data recorded", i.e. a statement about the session. This
 * banner's whole job is to correct that: the timing WAS recorded, and the load
 * is what failed.
 */
export const SPAN_LOAD_FAILURE =
  "Could not load the recorded trace for this session";

/** Follows {@link SPAN_LOAD_FAILURE} next to the timeline it qualifies. */
export const SPAN_LOAD_FAILURE_CONSEQUENCE =
  "the timeline below is empty for that reason, not because none was recorded";

/**
 * The timing fields a wall-clock anchor needs.
 *
 * Separate from {@link TurnTraceSpanSource} on purpose: `hydrateTurnTraceSpans`
 * never reads `endedAt`, and widening its input type would suggest otherwise.
 */
export type TurnTraceWallClockSource = {
  startedAt: number;
  endedAt: number;
};

/**
 * The session's absolute wall-clock bounds, for the timeline's hover tooltip.
 *
 * Filtered to FINITE values, and anchored on the same `Math.min` of `startedAt`
 * that {@link hydrateTurnTraceSpans} rebases from — so offset 0 on the axis and
 * the clock time printed beside it are the same instant by construction. One
 * garbage row used to hand the axis a NaN anchor while the spans kept a finite
 * base, which measured labels and positions from two different origins.
 *
 * `null` when nothing usable is left, which `getTraceStartAnchorMs` reads as
 * "no absolute clock" rather than an anchor at the epoch.
 */
export function turnTraceWallClockRange(
  traces: readonly TurnTraceWallClockSource[],
): { startedAtMs: number | null; endedAtMs: number | null } {
  const starts = traces
    .map((trace) => trace.startedAt)
    .filter((value) => Number.isFinite(value));
  const ends = traces
    .map((trace) => trace.endedAt)
    .filter((value) => Number.isFinite(value));
  return {
    startedAtMs: starts.length > 0 ? Math.min(...starts) : null,
    endedAtMs: ends.length > 0 ? Math.max(...ends) : null,
  };
}

/**
 * How many spans the turn ROWS claim their blobs hold.
 *
 * {@link hydrateTurnTraceSpans} swallows every per-blob failure and returns
 * `[]`, and `getRecordedSpans` reads `[]` as `undefined`, so the timeline drops
 * to its `mode: "none"` branch and says "No timing data recorded" — which is a
 * claim about the SESSION, not about the fetch. A session whose spans were
 * recorded and could not be loaded is told it never had any. That is the
 * BB-153 failure mode wearing a different face, so "the rows expected spans and
 * none arrived" has to be sayable.
 *
 * Shared so both readers draw that line in the same place. The guard is
 * `isSafeInteger && >= 0` rather than `?? 0`: this is a persisted count the
 * client does not validate, and a NaN would poison the total through the `+`
 * while a negative row could cancel a positive one out (`-1` and `1` sum to
 * `0`) — either way the total reads as "recorded nothing" and the warning it
 * gates goes silent, which is the single case it exists for.
 */
export function expectedTurnTraceSpanCount(
  traces: readonly { spanCount?: number | null }[],
): number {
  return traces.reduce(
    (total, trace) =>
      total +
      (Number.isSafeInteger(trace.spanCount) && (trace.spanCount as number) > 0
        ? (trace.spanCount as number)
        : 0),
    0,
  );
}
