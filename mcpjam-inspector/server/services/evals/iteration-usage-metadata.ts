import type { UsageTotals } from "./types";

/** Persist token breakdown on iteration metadata for run-detail charts. */
export function buildIterationUsageMetadata(
  usage: UsageTotals,
): Record<string, number> {
  const metadata: Record<string, number> = {};

  if (typeof usage.inputTokens === "number") {
    metadata.inputTokens = usage.inputTokens;
  }
  if (typeof usage.outputTokens === "number") {
    metadata.outputTokens = usage.outputTokens;
  }

  const total =
    typeof usage.totalTokens === "number" ? usage.totalTokens : undefined;
  if (total === undefined || total <= 0) {
    return metadata;
  }

  const input = metadata.inputTokens ?? 0;
  const output = metadata.outputTokens ?? 0;
  const sum = input + output;

  if (sum < total) {
    if (metadata.inputTokens === undefined && output > 0) {
      metadata.inputTokens = total - output;
    } else if (metadata.outputTokens === undefined && input > 0) {
      metadata.outputTokens = total - input;
    } else if (input === 0 && output > 0) {
      metadata.inputTokens = total - output;
    }
  }

  return metadata;
}

/**
 * The same token breakdown, shaped for the backend's structured
 * `testIteration.usage` field rather than the free-form metadata bag.
 *
 * Hosted finalize historically sent only `tokensUsed` + `metadata`, leaving
 * `usage` undefined on every hosted iteration — which is why the run-vs-run
 * diff fell back to trace tokens and reported no cost for them. Sending the
 * structured field fixes the diff's token metrics AND gives the backend the
 * input/output split it prices from when it stamps `estimatedCostUsd`.
 *
 * Derived from {@link buildIterationUsageMetadata} rather than from `usage`
 * directly, so the reconciled split (a missing half back-filled from the
 * total) is identical in both places — a cost priced off one and a chart
 * drawn off the other can never disagree.
 *
 * Returns `undefined` when there is no token signal at all: an empty object
 * would claim the iteration reported usage when it reported nothing.
 */
export function buildIterationUsagePayload(usage: UsageTotals):
  | { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  | undefined {
  const reconciled = buildIterationUsageMetadata(usage);
  const payload: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } = {};

  // ALL-ZERO IS NOT A MEASUREMENT. A runner that reported nothing arrives
  // here as `{ inputTokens: 0, outputTokens: 0, totalTokens: 0 }`, and
  // forwarding that split is not harmless: the backend's `hasTokenSignal`
  // accepts any numeric field, prices 0 input and 0 output at the model's
  // real rates, and stamps `estimatedCostUsd: 0` with
  // `costBasis.status: "estimated"` — a confident claim that the trial cost
  // nothing, about a trial nobody measured. That is the exact failure this
  // whole surface exists to prevent, so an all-zero split is withheld and
  // the backend answers `not_reported` / `no_tokens` instead.
  //
  // A zero half stays when the OTHER half is positive: "0 output tokens" is
  // a real reading when 500 input tokens went with it.
  const anyPositive =
    (reconciled.inputTokens ?? 0) > 0 ||
    (reconciled.outputTokens ?? 0) > 0 ||
    (usage.totalTokens ?? 0) > 0;
  if (anyPositive) {
    if (typeof reconciled.inputTokens === "number") {
      payload.inputTokens = reconciled.inputTokens;
    }
    if (typeof reconciled.outputTokens === "number") {
      payload.outputTokens = reconciled.outputTokens;
    }
    if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) {
      payload.totalTokens = usage.totalTokens;
    }
  }

  return Object.keys(payload).length > 0 ? payload : undefined;
}
