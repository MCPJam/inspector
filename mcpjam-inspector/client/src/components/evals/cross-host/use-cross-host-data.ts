import { useMemo } from "react";
import { computeIterationResult } from "../pass-criteria";
import type { EvalCase, EvalIteration, EvalSuite, EvalSuiteRun } from "../types";

export type HostColumn = {
  hostId: string;
  hostName: string | null;
  /** True when this host is no longer in hostAttachments (historical fallback). */
  isHistorical: boolean;
};

export type CellChips = {
  /** Total tools available before visibility filter, or null if not stamped. */
  toolsTotalBefore: number | null;
  /** Tools exposed to the model after visibility filter. */
  toolsExposed: number | null;
  /** Tools dropped by the visibility policy. */
  toolsDroppedVisibility: number | null;
  /** Sum of would-require-approval tool calls across iterations (requires requireToolApproval). */
  approvalsWouldRequire: number | null;
  /** True when any iteration has progressive_discovery_enabled=true. */
  progressiveDiscoveryEnabled: boolean;
  /** True when any iteration has openai_compat_injected=true. */
  openaiCompatInjected: boolean;
};

export type CellData = {
  iterations: EvalIteration[];
  passCount: number;
  failCount: number;
  pendingCount: number;
  totalCount: number;
  passRate: number | null;
  /**
   * Median (p50) latency across completed iterations in this cell, in ms.
   * Median over mean because at small iteration counts (1-10) a single
   * tail-latency host quirk skews the mean dramatically; the median
   * surfaces typical-case behavior, which is what the cell wants to
   * communicate at a glance. Full p95 takes ~20+ samples to be meaningful
   * and is deferred to a later pass.
   */
  medianLatencyMs: number | null;
  totalTokens: number;
  chips: CellChips;
};

export type CrossHostData = {
  hostColumns: HostColumn[];
  caseRows: Array<{ caseId: string; caseTitle: string }>;
  matrix: Map<string, Map<string, CellData>>;
  hasAnyData: boolean;
  hasHostAttachments: boolean;
};

function readMetaNumber(
  meta: Record<string, string | number | boolean> | undefined,
  key: string,
): number | null {
  const v = meta?.[key];
  return typeof v === "number" ? v : null;
}

function readMetaBool(
  meta: Record<string, string | number | boolean> | undefined,
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

function buildCellData(iterations: EvalIteration[]): CellData {
  let passCount = 0;
  let failCount = 0;
  let pendingCount = 0;
  let totalTokens = 0;
  const latencySamples: number[] = [];

  // Chip aggregates — use first stamped value for counts, OR across iterations for booleans
  let toolsTotalBefore: number | null = null;
  let toolsExposed: number | null = null;
  let toolsDroppedVisibility: number | null = null;
  let approvalsWouldRequire: number | null = null;
  let progressiveDiscoveryEnabled = false;
  let openaiCompatInjected = false;

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

    const meta = iter.metadata;
    if (meta) {
      if (toolsTotalBefore === null) toolsTotalBefore = readMetaNumber(meta, "tools_total_before");
      if (toolsExposed === null) toolsExposed = readMetaNumber(meta, "tools_exposed");
      if (toolsDroppedVisibility === null)
        toolsDroppedVisibility = readMetaNumber(meta, "tools_dropped_visibility");
      const approvals = readMetaNumber(meta, "approvals_would_require");
      if (approvals !== null) {
        approvalsWouldRequire = (approvalsWouldRequire ?? 0) + approvals;
      }
      if (readMetaBool(meta, "progressive_discovery_enabled")) progressiveDiscoveryEnabled = true;
      if (readMetaBool(meta, "openai_compat_injected")) openaiCompatInjected = true;
    }
  }

  const totalCount = iterations.length;
  const completed = passCount + failCount;
  const passRate = completed > 0 ? (passCount / completed) * 100 : null;
  const medianLatencyMs = median(latencySamples);

  return {
    iterations,
    passCount,
    failCount,
    pendingCount,
    totalCount,
    passRate,
    medianLatencyMs,
    totalTokens,
    chips: {
      toolsTotalBefore,
      toolsExposed,
      toolsDroppedVisibility,
      approvalsWouldRequire,
      progressiveDiscoveryEnabled,
      openaiCompatInjected,
    },
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

    // Build matrix: caseId → hostId → CellData
    // Only include iterations from active runs that have a namedHostId
    const rawMatrix = new Map<string, Map<string, EvalIteration[]>>();

    for (const iter of allIterations) {
      if (!iter.suiteRunId || !activeRunIds.has(iter.suiteRunId)) continue;
      const hostId = runHostMap.get(iter.suiteRunId);
      if (!hostId) continue;
      const caseId = iter.testCaseId ?? `__no_case_${iter._id}`;

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
