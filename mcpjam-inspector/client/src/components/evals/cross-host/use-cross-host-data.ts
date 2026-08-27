import { useMemo } from "react";
import { compactModelIdTail } from "@/lib/environment-label";
import { formatRunId, runEnvironmentRef } from "../helpers";
import { computeIterationResult } from "../pass-criteria";
import type {
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteRun,
} from "../types";

export const CLIENT_DEFAULT_MODEL_KEY = "client-default";

export type CrossHostEnvironment = {
  environmentId: string;
  hostId: string;
  modelId?: string;
  serverAttachmentId?: string | null;
  skillSelection?: {
    skillIds: string[];
    /**
     * Exact-version pins. Carried because two environments can differ ONLY in
     * which revision they hold a skill at — that is the side-by-side comparison
     * the feature exists for, and it must not collapse into one cell.
     */
    versionPins?: { skillId: string; versionId: string }[];
  } | null;
  computerEnvironmentId?: string | null;
  pluginVersionIds?: string[];
};

export type HostColumn = {
  hostId: string;
  /** `(hostId, modelKey)` or per-env when a shared-slot collision splits. */
  columnKey?: string;
  modelKey?: string;
  modelLabel?: string | null;
  hostName: string | null;
  /**
   * True when this host is no longer in hostAttachments AND no environment-backed
   * run resolved to it — i.e. genuinely detached, not merely run-derived.
   */
  isHistorical: boolean;
  /** Annotating segment when a collision split this cell (e.g. `"sandbox-x"`). */
  splitLabel?: string | null;
};

export type CellTrendPoint = {
  runId: string;
  runLabel: string;
  timestamp: number;
  result: "passed" | "failed" | "pending" | "partial";
  /** Passed iterations for this run in the cell. */
  passed: number;
  /** Failed iterations for this run in the cell. */
  failed: number;
  /** Total iterations for this run in the cell. */
  total: number;
  /** Median (p50) latency for this run in the cell. */
  latencyMs: number | null;
  /** 95th percentile latency for this run in the cell. */
  latencyP95Ms: number | null;
  tokens: number | null;
  /** Mean tool calls per iteration in this run. */
  toolCalls: number | null;
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
  /** Mean `tokensUsed` per iteration in this cell (all iterations in the latest run). */
  avgTokensPerIteration: number | null;
  /** Chronological run history for this (case, host), oldest first. */
  trendSeries?: CellTrendPoint[];
};

export type CrossHostData = {
  hostColumns: HostColumn[];
  caseRows: Array<{ caseId: string; caseTitle: string }>;
  matrix: Map<string, Map<string, CellData>>;
  hasAnyData: boolean;
  hasHostAttachments: boolean;
};

export type UseCrossHostDataOptions = {
  /** When true, attach per-cell run trend series (All runs view). */
  cellTrends?: boolean;
  /**
   * `namedHostId` → display name for hosts the suite does not carry an
   * attachment for — sourced from the project host list (`useHostList`), which
   * the caller owns so this hook (and the components around it) stay
   * queryless. Without it, run-derived columns can only show a truncated id.
   */
  hostNamesById?: Map<string, string | null>;
  /**
   * Project environments for the suite — used to derive `modelKey` and to
   * detect shared-slot collisions that must split a (host, model) cell.
   */
  environments?: readonly CrossHostEnvironment[];
};

/** Fallback display name for a host with no resolved name: last 6 id chars. */
export function formatHostFallback(hostId: string): string {
  return `…${hostId.slice(-6)}`;
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

export type CellOutcome = "pass" | "fail" | "part" | "running";

/**
 * Settle a cell's pass/fail/running state from its iteration counts.
 *
 * A cell whose iterations are still pending/running — and where nothing has
 * completed yet — is "running", NOT "fail". This is the difference between
 * "this case hasn't produced a verdict yet" and "this case produced a failing
 * verdict". Without the running branch, every cell flashes red the instant a
 * "Run all" starts (all iterations pending → passCount 0) and only flips to
 * green as each iteration finishes. Mirrors `trendResultFromCounts`.
 */
export function cellOutcome(cell: {
  passCount: number;
  failCount: number;
  pendingCount: number;
  totalCount: number;
}): CellOutcome {
  if (cell.pendingCount > 0 && cell.passCount + cell.failCount === 0) {
    return "running";
  }
  if (cell.passCount >= cell.totalCount) return "pass";
  if (cell.passCount === 0) return "fail";
  return "part";
}

function trendResultFromCounts(
  passCount: number,
  failCount: number,
  pendingCount: number,
  totalCount: number,
): CellTrendPoint["result"] {
  if (totalCount === 0) return "pending";
  if (pendingCount > 0 && passCount + failCount === 0) return "pending";
  if (passCount >= totalCount) return "passed";
  if (passCount === 0 && failCount > 0) return "failed";
  if (passCount === 0) return "pending";
  return "partial";
}

function iterationLatencyMs(iter: EvalIteration): number | null {
  if (!iter.startedAt || !iter.updatedAt || iter.status !== "completed") {
    return null;
  }
  const latency = iter.updatedAt - iter.startedAt;
  return latency > 0 ? latency : null;
}

/**
 * Build a chronological run-history series for one (caseId, hostId) pair.
 * Exported for unit tests.
 */
export function buildCellTrendSeries(
  caseId: string,
  columnKey: string,
  runs: EvalSuiteRun[],
  allIterations: EvalIteration[],
  runHostMap: Map<string, string>,
  activeRunIds: Set<string>,
  formatRunIdFn: (id: string) => string = formatRunId,
): CellTrendPoint[] {
  const itersByRun = new Map<string, EvalIteration[]>();

  for (const iter of allIterations) {
    if (!iter.suiteRunId || !activeRunIds.has(iter.suiteRunId)) continue;
    if (runHostMap.get(iter.suiteRunId) !== columnKey) continue;
    const iterCaseId = iter.testCaseId ?? `__no_case_${iter._id}`;
    if (iterCaseId !== caseId) continue;

    const list = itersByRun.get(iter.suiteRunId);
    if (list) list.push(iter);
    else itersByRun.set(iter.suiteRunId, [iter]);
  }

  const relevantRuns = runs
    .filter((run) => itersByRun.has(run._id))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

  return relevantRuns.map((run) => {
    const iters = itersByRun.get(run._id) ?? [];
    let passCount = 0;
    let failCount = 0;
    let pendingCount = 0;
    let totalTokens = 0;
    let totalToolCalls = 0;
    const latencySamples: number[] = [];

    for (const iter of iters) {
      const result = computeIterationResult(iter);
      if (result === "passed") passCount++;
      else if (result === "failed") failCount++;
      else pendingCount++;

      totalTokens += iter.tokensUsed || 0;
      totalToolCalls += iter.actualToolCalls?.length ?? 0;

      const latency = iterationLatencyMs(iter);
      if (latency != null) latencySamples.push(latency);
    }

    const totalCount = iters.length;

    return {
      runId: run._id,
      runLabel: formatRunIdFn(run._id),
      timestamp: run.completedAt ?? run.createdAt ?? 0,
      result: trendResultFromCounts(
        passCount,
        failCount,
        pendingCount,
        totalCount,
      ),
      passed: passCount,
      failed: failCount,
      total: totalCount,
      latencyMs: median(latencySamples),
      latencyP95Ms: percentile(latencySamples, 95),
      tokens:
        totalCount > 0 && totalTokens > 0 ? totalTokens / totalCount : null,
      toolCalls: totalCount > 0 ? totalToolCalls / totalCount : null,
    };
  });
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

    const latency = iterationLatencyMs(iter);
    if (latency != null) latencySamples.push(latency);
  }

  const totalCount = iterations.length;
  const completed = passCount + failCount;
  const passRate = completed > 0 ? (passCount / completed) * 100 : null;
  const p50LatencyMs = median(latencySamples);
  const p95LatencyMs = percentile(latencySamples, 95);
  const avgTokensPerIteration =
    totalCount > 0 && totalTokens > 0 ? totalTokens / totalCount : null;

  return {
    iterations,
    passCount,
    failCount,
    pendingCount,
    totalCount,
    passRate,
    p50LatencyMs,
    p95LatencyMs,
    avgTokensPerIteration,
  };
}

function slotFingerprint(env: CrossHostEnvironment): string {
  const skills = skillSlotKey(env);
  const plugins = [...(env.pluginVersionIds ?? [])].sort().join(",");
  return [
    env.serverAttachmentId ?? "",
    skills,
    env.computerEnvironmentId ?? "",
    plugins,
  ].join("|");
}

/** Which shared slot separates these environments, or null if none does. */
type DifferingSlot = "servers" | "skills" | "sandbox" | "plugins";

function differingSlot(envs: CrossHostEnvironment[]): DifferingSlot | null {
  if (envs.length < 2) return null;
  const first = envs[0]!;
  const differsOn = (read: (env: CrossHostEnvironment) => string) =>
    envs.some((env) => read(env) !== read(first));

  if (differsOn((env) => env.serverAttachmentId ?? "")) return "servers";
  if (differsOn(skillSlotKey)) {
    return "skills";
  }
  if (differsOn((env) => env.computerEnvironmentId ?? "")) return "sandbox";
  if (differsOn((env) => sortedIds(env.pluginVersionIds))) return "plugins";
  return null;
}

function sortedIds(ids: readonly string[] | undefined): string {
  return [...(ids ?? [])].sort().join(",");
}

/**
 * The skill slot's identity: WHICH skills, and at which revision each is held.
 *
 * The revision half is load-bearing. Two environments selecting the same skill
 * ids at different pinned revisions are two different executions — comparing
 * them is the whole point — so a key built from ids alone would report them as
 * one slot, merge their runs into a single cell, and average away the very
 * difference under test.
 */
function skillSlotKey(env: CrossHostEnvironment): string {
  const ids = sortedIds(env.skillSelection?.skillIds);
  const pins = [...(env.skillSelection?.versionPins ?? [])]
    .map((pin) => `${pin.skillId}@${pin.versionId}`)
    .sort()
    .join(",");
  return pins ? `${ids}#${pins}` : ids;
}

/**
 * How ONE environment reads along the slot that split its cell.
 *
 * The label has to differ per environment, because telling the split columns
 * apart is the entire reason the cell split. Naming the slot alone would print
 * the same annotation on every column — and reading the sandbox pin regardless
 * of which slot actually differs would do it too, while also naming the wrong
 * dimension.
 */
function splitLabelFor(
  env: CrossHostEnvironment,
  slot: DifferingSlot | null,
): string | null {
  switch (slot) {
    case "servers":
      return env.serverAttachmentId
        ? `servers-${env.serverAttachmentId.slice(-4)}`
        : "no servers";
    case "skills": {
      // When the split is BY revision, a skill count is the one thing that
      // cannot tell the columns apart — every column would read "1 skill".
      // Name the pinned revisions instead.
      const pins = env.skillSelection?.versionPins ?? [];
      if (pins.length > 0) {
        return `pinned ${
          pins.length === 1 ? "1 version" : `${pins.length} versions`
        }`;
      }
      const count = env.skillSelection?.skillIds.length ?? 0;
      return count === 0
        ? "no skills"
        : `${count} skill${count === 1 ? "" : "s"}`;
    }
    case "sandbox":
      return env.computerEnvironmentId
        ? `sandbox-${env.computerEnvironmentId.slice(-4)}`
        : "no sandbox";
    case "plugins": {
      const count = env.pluginVersionIds?.length ?? 0;
      return count === 0
        ? "no plugins"
        : `${count} plugin${count === 1 ? "" : "s"}`;
    }
    default:
      return null;
  }
}

export function modelKeyForRun(
  run: EvalSuiteRun,
  envById: Map<string, CrossHostEnvironment>,
): string {
  // Persisted attribution is the run's frozen column. A later edit to the
  // named environment must not move historical runs into a new model cell
  // (or recast an inherit run as an override).
  if (run.modelSource === "override" && run.effectiveModelId) {
    return run.effectiveModelId;
  }
  if (run.modelSource === "client_default") {
    return CLIENT_DEFAULT_MODEL_KEY;
  }
  // Pre-attribution rows: join the live environment if present.
  const ref = runEnvironmentRef(run);
  const env = ref ? envById.get(ref.environmentId) : undefined;
  if (env?.modelId) return env.modelId;
  return CLIENT_DEFAULT_MODEL_KEY;
}

function modelLabelForKey(modelKey: string): string | null {
  if (modelKey === CLIENT_DEFAULT_MODEL_KEY) return null;
  return compactModelIdTail(modelKey);
}

export function useCrossHostData(
  suite: EvalSuite,
  cases: EvalCase[],
  runs: EvalSuiteRun[],
  allIterations: EvalIteration[],
  options: UseCrossHostDataOptions = {},
): CrossHostData {
  const { cellTrends = false, hostNamesById, environments } = options;

  return useMemo(() => {
    const attachments = suite.hostAttachments ?? [];
    const hasHostAttachments = attachments.length > 0;
    const envById = new Map(
      (environments ?? []).map((env) => [env.environmentId, env]),
    );

    const activeRunIds = new Set(runs.map((r) => r._id));
    const attachedHostIds = new Set(attachments.map((a) => a.namedHostId));

    type PendingColumn = {
      hostId: string;
      modelKey: string;
      envIds: string[];
      isHistorical: boolean;
    };
    const pending = new Map<string, PendingColumn>();
    const groupKey = (hostId: string, modelKey: string) =>
      `${hostId}::${modelKey}`;

    const touch = (
      hostId: string,
      modelKey: string,
      opts: { envId?: string; historical: boolean },
    ) => {
      const key = groupKey(hostId, modelKey);
      const existing = pending.get(key);
      if (!existing) {
        pending.set(key, {
          hostId,
          modelKey,
          envIds: opts.envId ? [opts.envId] : [],
          isHistorical: opts.historical,
        });
        return;
      }
      if (opts.envId && !existing.envIds.includes(opts.envId)) {
        existing.envIds.push(opts.envId);
      }
      existing.isHistorical = existing.isHistorical && opts.historical;
    };

    for (const a of attachments) {
      touch(a.namedHostId, CLIENT_DEFAULT_MODEL_KEY, { historical: false });
    }

    for (const run of runs) {
      if (!run.namedHostId) continue;
      const modelKey = modelKeyForRun(run, envById);
      const ref = runEnvironmentRef(run);
      const historical = !attachedHostIds.has(run.namedHostId) && ref === null;
      touch(run.namedHostId, modelKey, {
        envId: ref?.environmentId,
        historical,
      });
    }

    // The caller often hands the project's full named-environment list.
    // Only environments attached to this suite, or referenced by a
    // displayed run, should mint columns — otherwise every other named
    // row in the project appears as an empty host/model cell.
    const relevantEnvIds = new Set<string>(suite.environmentIds ?? []);
    for (const run of runs) {
      const ref = runEnvironmentRef(run);
      if (ref) relevantEnvIds.add(ref.environmentId);
    }

    for (const env of environments ?? []) {
      if (!env.hostId) continue;
      if (!relevantEnvIds.has(env.environmentId)) continue;
      const modelKey = env.modelId ?? CLIENT_DEFAULT_MODEL_KEY;
      touch(env.hostId, modelKey, {
        envId: env.environmentId,
        historical: false,
      });
    }

    const resolveHostName = (hostId: string): string | null =>
      attachments.find((a) => a.namedHostId === hostId)?.hostName ??
      hostNamesById?.get(hostId) ??
      null;

    // Runs with no environmentRef cannot land in a split column. If a
    // colliding group also has a legacy host-backed run, keep the plain
    // group key alive so those iterations stay visible.
    const groupsNeedingResidual = new Set<string>();
    for (const run of runs) {
      if (!run.namedHostId) continue;
      if (runEnvironmentRef(run)) continue;
      groupsNeedingResidual.add(
        groupKey(run.namedHostId, modelKeyForRun(run, envById)),
      );
    }

    const hostColumns: HostColumn[] = [];
    for (const group of pending.values()) {
      const groupEnvs = group.envIds
        .map((id) => envById.get(id))
        .filter((e): e is CrossHostEnvironment => Boolean(e));
      const fps = new Set(groupEnvs.map(slotFingerprint));
      const collide = fps.size > 1;
      if (collide) {
        const slot = differingSlot(groupEnvs);
        for (const env of groupEnvs) {
          hostColumns.push({
            hostId: group.hostId,
            columnKey: `${group.hostId}::${group.modelKey}::${env.environmentId}`,
            modelKey: group.modelKey,
            modelLabel: modelLabelForKey(group.modelKey),
            hostName: resolveHostName(group.hostId),
            isHistorical: group.isHistorical,
            splitLabel: splitLabelFor(env, slot),
          });
        }
        if (
          !groupsNeedingResidual.has(groupKey(group.hostId, group.modelKey))
        ) {
          continue;
        }
      }
      hostColumns.push({
        hostId: group.hostId,
        columnKey: groupKey(group.hostId, group.modelKey),
        modelKey: group.modelKey,
        modelLabel: modelLabelForKey(group.modelKey),
        hostName: resolveHostName(group.hostId),
        isHistorical: group.isHistorical,
      });
    }

    // Build run → columnKey index (only active runs)
    const runHostMap = new Map<string, string>();
    for (const run of runs) {
      if (!run.namedHostId || !activeRunIds.has(run._id)) continue;
      const modelKey = modelKeyForRun(run, envById);
      const ref = runEnvironmentRef(run);
      const splitCol = hostColumns.find(
        (col) =>
          col.hostId === run.namedHostId &&
          col.modelKey === modelKey &&
          col.splitLabel &&
          ref &&
          col.columnKey?.endsWith(`::${ref.environmentId}`),
      );
      runHostMap.set(
        run._id,
        splitCol?.columnKey ?? groupKey(run.namedHostId, modelKey),
      );
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

      if (winningRunByCell.get(caseId)?.get(hostId) !== iter.suiteRunId)
        continue;

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
      for (const [columnKey, iters] of byHost) {
        const cell = buildCellData(iters);
        if (cellTrends) {
          const trendSeries = buildCellTrendSeries(
            caseId,
            columnKey,
            runs,
            allIterations,
            runHostMap,
            activeRunIds,
          );
          if (trendSeries.length > 0) {
            cellMap.set(columnKey, { ...cell, trendSeries });
            continue;
          }
        }
        cellMap.set(columnKey, cell);
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
  }, [
    suite.hostAttachments,
    cases,
    runs,
    allIterations,
    cellTrends,
    hostNamesById,
    environments,
  ]);
}
