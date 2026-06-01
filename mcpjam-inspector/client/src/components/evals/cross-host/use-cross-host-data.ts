import { useMemo } from "react";
import { computeIterationResult } from "../pass-criteria";
import type { EvalCase, EvalIteration, EvalSuite, EvalSuiteRun } from "../types";

export type HostColumn = {
  hostId: string;
  hostName: string | null;
  /** True when this host is no longer in hostAttachments (historical fallback). */
  isHistorical: boolean;
};

export type CellData = {
  iterations: EvalIteration[];
  passCount: number;
  failCount: number;
  pendingCount: number;
  totalCount: number;
  passRate: number | null;
  /** Median (p50) latency across completed iterations in this cell, in ms. */
  p50LatencyMs: number | null;
  /** 95th percentile latency across completed iterations in this cell, in ms. */
  p95LatencyMs: number | null;
  totalTokens: number;
};

export type CrossHostData = {
  hostColumns: HostColumn[];
  caseRows: Array<{ caseId: string; caseTitle: string }>;
  matrix: Map<string, Map<string, CellData>>;
  hasAnyData: boolean;
  hasHostAttachments: boolean;
};

function readMetaNumber(
  meta: Record<string, unknown> | undefined,
  key: string,
): number | null {
  const v = meta?.[key];
  return typeof v === "number" ? v : null;
}

function readMetaBool(
  meta: Record<string, unknown> | undefined,
  key: string,
): boolean {
  return meta?.[key] === true;
}

/**
 * Median of a numeric array. Returns null on empty input. Sorts a copy —
 * does not mutate the caller's array. Even-length lists use the mean of
 * the two middle samples, which is the standard p50 convention.
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Linear-interpolation percentile (PERCENTILE.INC). */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function buildCellData(iterations: EvalIteration[]): CellData {
  let passCount = 0;
  let failCount = 0;
  let pendingCount = 0;
  let totalTokens = 0;
  const latencySamples: number[] = [];

  for (const iter of iterations) {
    const result = computeIterationResult(iter);
    if (result === "passed") passCount++;
    else if (result === "failed") failCount++;
    else pendingCount++;

    totalTokens += iter.tokensUsed || 0;

    if (iter.startedAt && iter.updatedAt && iter.status === "completed") {
      const latency = iter.updatedAt - iter.startedAt;
      if (latency > 0) {
        latencySamples.push(latency);
      }
    }
  }

  const totalCount = iterations.length;
  const completed = passCount + failCount;
  const passRate = completed > 0 ? (passCount / completed) * 100 : null;
  const p50LatencyMs = median(latencySamples);
  const p95LatencyMs = percentile(latencySamples, 95);

  return {
    iterations,
    passCount,
    failCount,
    pendingCount,
    totalCount,
    passRate,
    p50LatencyMs,
    p95LatencyMs,
    totalTokens,
  };
}

export function useCrossHostData(
  suite: EvalSuite,
  cases: EvalCase[],
  runs: EvalSuiteRun[],
  allIterations: EvalIteration[],
): CrossHostData {
  return useMemo(() => {
    const attachments = suite.hostAttachments ?? [];
    const hasHostAttachments = attachments.length > 0;

    // Build ordered host columns from attachments
    const attachedHostIds = new Set(attachments.map((a) => a.namedHostId));
    const hostColumns: HostColumn[] = attachments.map((a) => ({
      hostId: a.namedHostId,
      hostName: a.hostName,
      isHistorical: false,
    }));

    // Index active run IDs to avoid orphaned historical iterations
    const activeRunIds = new Set(runs.map((r) => r._id));

    // Find historical namedHostIds from runs that are no longer attached
    const historicalHostIds = new Set<string>();
    for (const run of runs) {
      if (run.namedHostId && !attachedHostIds.has(run.namedHostId)) {
        historicalHostIds.add(run.namedHostId);
      }
    }

    // Append stable fallback columns for historical host IDs
    for (const hostId of historicalHostIds) {
      hostColumns.push({ hostId, hostName: null, isHistorical: true });
    }

    // Build run → namedHostId index (only active runs)
    const runHostMap = new Map<string, string>();
    for (const run of runs) {
      if (run.namedHostId && activeRunIds.has(run._id)) {
        runHostMap.set(run._id, run.namedHostId);
      }
    }

    // Rank runs newest-first by completedAt ?? createdAt so cells can be
    // pinned to the latest run per (case, host). Reruns against the same host
    // would otherwise pile every historical iteration into one cell —
    // contradicting the "Last run" semantics shown by the by-case toggle and
    // polluting tokens/latency with stale runs.
    const runRank = new Map<string, number>();
    [...runs]
      .sort((a, b) => {
        const tA = a.completedAt ?? a.createdAt ?? 0;
        const tB = b.completedAt ?? b.createdAt ?? 0;
        return tB - tA;
      })
      .forEach((r, i) => runRank.set(r._id, i));

    // First pass: pick the latest active run per (caseId, hostId)
    const winningRunByCell = new Map<string, Map<string, string>>();
    for (const iter of allIterations) {
      if (!iter.suiteRunId || !activeRunIds.has(iter.suiteRunId)) continue;
      const hostId = runHostMap.get(iter.suiteRunId);
      if (!hostId) continue;
      const caseId = iter.testCaseId ?? `__no_case_${iter._id}`;

      let byHost = winningRunByCell.get(caseId);
      if (!byHost) {
        byHost = new Map();
        winningRunByCell.set(caseId, byHost);
      }
      const current = byHost.get(hostId);
      const iterRank = runRank.get(iter.suiteRunId) ?? Number.POSITIVE_INFINITY;
      const currentRank = current
        ? runRank.get(current) ?? Number.POSITIVE_INFINITY
        : Number.POSITIVE_INFINITY;
      if (!current || iterRank < currentRank) {
        byHost.set(hostId, iter.suiteRunId);
      }
    }

    // Second pass: collect iterations only from the winning run per cell
    const rawMatrix = new Map<string, Map<string, EvalIteration[]>>();
    for (const iter of allIterations) {
      if (!iter.suiteRunId || !activeRunIds.has(iter.suiteRunId)) continue;
      const hostId = runHostMap.get(iter.suiteRunId);
      if (!hostId) continue;
      const caseId = iter.testCaseId ?? `__no_case_${iter._id}`;

      if (winningRunByCell.get(caseId)?.get(hostId) !== iter.suiteRunId) continue;

      let byHost = rawMatrix.get(caseId);
      if (!byHost) {
        byHost = new Map();
        rawMatrix.set(caseId, byHost);
      }
      const existing = byHost.get(hostId) ?? [];
      existing.push(iter);
      byHost.set(hostId, existing);
    }

    // Build computed matrix
    const matrix = new Map<string, Map<string, CellData>>();
    for (const [caseId, byHost] of rawMatrix) {
      const cellMap = new Map<string, CellData>();
      for (const [hostId, iters] of byHost) {
        cellMap.set(hostId, buildCellData(iters));
      }
      matrix.set(caseId, cellMap);
    }

    // Ordered case rows from cases prop; include any extra caseIds from matrix
    // that don't appear in cases (shouldn't happen in practice, but be safe).
    const caseIdSet = new Set(cases.map((c) => c._id));
    const caseRows: Array<{ caseId: string; caseTitle: string }> = cases.map(
      (c) => ({ caseId: c._id, caseTitle: c.title }),
    );
    for (const caseId of rawMatrix.keys()) {
      if (!caseIdSet.has(caseId) && !caseId.startsWith("__no_case_")) {
        caseRows.push({ caseId, caseTitle: caseId });
      }
    }

    const hasAnyData = matrix.size > 0;

    return { hostColumns, caseRows, matrix, hasAnyData, hasHostAttachments };
  }, [suite.hostAttachments, cases, runs, allIterations]);
}
