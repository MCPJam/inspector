import { percentile } from "./helpers";
import { readIterationTokenBreakdown } from "./iteration-token-usage";
import type { RunCaseGroup } from "./run-case-groups";
import { computeIterationResult } from "./pass-criteria";
import type { EvalIteration } from "./types";

export type DurationChartDatum = {
  name: string;
  p50Ms: number;
  p95Ms: number;
  p50Seconds: number;
  /** Seconds from p50 to p95 (stacked above p50). */
  p95TailSeconds: number;
};

export type TokensChartDatum = {
  name: string;
  inputP50: number;
  outputP50: number;
  inputP95Tail: number;
  outputP95Tail: number;
};

function completedIterations(iterations: EvalIteration[]): EvalIteration[] {
  return iterations.filter((it) => {
    const result = computeIterationResult(it);
    return result === "passed" || result === "failed";
  });
}

function p95Tail(p50: number | null, p95: number | null): number {
  if (p50 === null || p95 === null) return 0;
  return Math.max(p95 - p50, 0);
}

export function buildDurationChartData(
  groups: RunCaseGroup[],
): DurationChartDatum[] {
  return groups
    .map((group) => {
      const p50Ms = group.p50Ms;
      const p95Ms = group.p95Ms;
      if (p50Ms === null && p95Ms === null) return null;
      const p50 = p50Ms ?? p95Ms ?? 0;
      const p95 = p95Ms ?? p50Ms ?? 0;
      return {
        name: group.title,
        p50Ms: p50,
        p95Ms: p95,
        p50Seconds: p50 / 1000,
        p95TailSeconds: p95Tail(p50, p95) / 1000,
      };
    })
    .filter((row): row is DurationChartDatum => row !== null);
}

export function buildTokensChartData(
  groups: RunCaseGroup[],
): TokensChartDatum[] {
  return groups
    .map((group) => {
      const breakdowns = completedIterations(group.iterations)
        .map(readIterationTokenBreakdown)
        .filter((row): row is NonNullable<typeof row> => row !== null);
      if (breakdowns.length === 0) return null;

      const inputSeries = breakdowns.map((b) => b.inputTokens);
      const outputSeries = breakdowns.map((b) => b.outputTokens);
      const inputP50 = percentile(inputSeries, 0.5) ?? 0;
      const inputP95 = percentile(inputSeries, 0.95) ?? inputP50;
      const outputP50 = percentile(outputSeries, 0.5) ?? 0;
      const outputP95 = percentile(outputSeries, 0.95) ?? outputP50;

      const totalP95 = inputP95 + outputP95;
      if (totalP95 <= 0) return null;

      return {
        name: group.title,
        inputP50,
        outputP50,
        inputP95Tail: p95Tail(inputP50, inputP95),
        outputP95Tail: p95Tail(outputP50, outputP95),
      };
    })
    .filter((row): row is TokensChartDatum => row !== null);
}

export function buildRunMetricsChartData(groups: RunCaseGroup[]): {
  durationData: DurationChartDatum[];
  tokensData: TokensChartDatum[];
} {
  return {
    durationData: buildDurationChartData(groups),
    tokensData: buildTokensChartData(groups),
  };
}

export function tokensChartDatumTotal(datum: TokensChartDatum): number {
  return (
    datum.inputP50 +
    datum.outputP50 +
    datum.inputP95Tail +
    datum.outputP95Tail
  );
}
