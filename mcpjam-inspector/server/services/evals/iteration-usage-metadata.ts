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
