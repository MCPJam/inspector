/**
 * Codex token accounting → the harness usage shape.
 *
 * Codex reports CUMULATIVE `total` plus a per-request `last` on every
 * `thread/tokenUsage/updated`. The harness wants per-step usage on `finish-step`
 * and per-TURN usage on `finish`. Neither is `total` directly: a resumed thread
 * carries usage from earlier turns, so reporting `total` as the turn's usage
 * would bill turn 5 for turns 1-4 as well.
 *
 * So the turn's usage is a DIFFERENCE against the snapshot taken when the turn
 * began. Compaction is the case that breaks the subtraction — it can lower the
 * cumulative counters — and there the difference goes negative, which is when
 * the sum of the observed `last` values is the better answer. Both are kept.
 */
import type { TokenUsageBreakdown } from "./app-server-protocol.js";

/** `LanguageModelV4Usage`, structurally. Declared locally so the bridge bundle
 *  does not pull the provider package in for one type. */
export type HarnessUsage = {
  inputTokens: {
    total?: number;
    noCache?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  outputTokens: { total?: number; text?: number; reasoning?: number };
  raw?: Record<string, unknown>;
};

export function zeroUsage(): HarnessUsage {
  return { inputTokens: {}, outputTokens: {} };
}

/**
 * One Codex breakdown → one harness usage value.
 *
 * `noCache` and `text` are DERIVED, not reported: Codex gives totals plus the
 * cached/reasoning components, and the harness shape wants the remainder. They
 * are clamped at zero rather than allowed to go negative — a negative token
 * count is never the truth, and it would propagate into billing telemetry.
 *
 * `cacheWrite` is subtracted from `noCache` because the two are DISJOINT in
 * this shape, which is not obvious from the field docs ("non-cached input
 * tokens" reads like it should include tokens written to cache, since those
 * were processed fresh). The ecosystem's own answer settles it:
 * `@ai-sdk/harness-claude-code` maps Anthropic's disjoint triple straight
 * across — `noCache: input_tokens`, `cacheWrite: cache_creation_input_tokens`,
 * with `total` the SUM of all three — so a consumer that adds the components
 * expects no overlap. The published `@ai-sdk/harness-codex` sidesteps the
 * question by reporting `cacheWrite: 0` unconditionally; this adapter forwards
 * what Codex actually reports, so it has to get the subtraction right. Every
 * capture so far has `cacheWriteInputTokens: 0`, which is exactly why this
 * would have gone unnoticed until it did not.
 */
export function toHarnessUsage(
  breakdown: TokenUsageBreakdown | undefined,
): HarnessUsage {
  if (!breakdown) return zeroUsage();
  const input = breakdown.inputTokens;
  const cacheRead = breakdown.cachedInputTokens;
  const cacheWrite = breakdown.cacheWriteInputTokens;
  const output = breakdown.outputTokens;
  const reasoning = breakdown.reasoningOutputTokens;
  return {
    inputTokens: {
      ...(input !== undefined ? { total: input } : {}),
      ...(input !== undefined && cacheRead !== undefined
        ? { noCache: Math.max(0, input - cacheRead - (cacheWrite ?? 0)) }
        : {}),
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    },
    outputTokens: {
      ...(output !== undefined ? { total: output } : {}),
      ...(output !== undefined && reasoning !== undefined
        ? { text: Math.max(0, output - reasoning) }
        : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    },
    raw: { ...breakdown },
  };
}

const sub = (a?: number, b?: number): number | undefined =>
  a === undefined ? undefined : a - (b ?? 0);

/**
 * Cumulative totals at turn end minus the snapshot at turn start.
 *
 * Returns `undefined` when the subtraction is not trustworthy (any component
 * negative — the compaction case), so the caller can fall back to the summed
 * per-request values instead of reporting a nonsense number.
 */
export function diffUsage(
  end: TokenUsageBreakdown | undefined,
  start: TokenUsageBreakdown | undefined,
): HarnessUsage | undefined {
  if (!end) return undefined;
  const diff: TokenUsageBreakdown = {
    totalTokens: sub(end.totalTokens, start?.totalTokens),
    inputTokens: sub(end.inputTokens, start?.inputTokens),
    cachedInputTokens: sub(end.cachedInputTokens, start?.cachedInputTokens),
    cacheWriteInputTokens: sub(
      end.cacheWriteInputTokens,
      start?.cacheWriteInputTokens,
    ),
    outputTokens: sub(end.outputTokens, start?.outputTokens),
    reasoningOutputTokens: sub(
      end.reasoningOutputTokens,
      start?.reasoningOutputTokens,
    ),
  };
  const negative = Object.values(diff).some(
    (value) => typeof value === "number" && value < 0,
  );
  return negative ? undefined : toHarnessUsage(diff);
}

/** Component-wise sum, for the fallback path. */
export function addBreakdowns(
  a: TokenUsageBreakdown,
  b: TokenUsageBreakdown | undefined,
): TokenUsageBreakdown {
  if (!b) return a;
  const add = (x?: number, y?: number) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  return {
    totalTokens: add(a.totalTokens, b.totalTokens),
    inputTokens: add(a.inputTokens, b.inputTokens),
    cachedInputTokens: add(a.cachedInputTokens, b.cachedInputTokens),
    cacheWriteInputTokens: add(
      a.cacheWriteInputTokens,
      b.cacheWriteInputTokens,
    ),
    outputTokens: add(a.outputTokens, b.outputTokens),
    reasoningOutputTokens: add(
      a.reasoningOutputTokens,
      b.reasoningOutputTokens,
    ),
  };
}
