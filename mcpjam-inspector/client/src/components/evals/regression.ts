/**
 * Suite-run-to-suite-run regression detection.
 *
 * Computes per-(testCaseId, executionConfigKey) pass-rate deltas between
 * a completed suite run and the most recent prior completed run on the
 * same suite. Flags any pair whose pass-rate dropped more than the
 * configured `thresholdPct` (default 10%).
 *
 * The grouping key bakes in provider + tool choice on top of any
 * `hostConfigId` the backend already records, so two configs that
 * differ only in provider/toolChoice get compared separately (per the
 * Phase 3 design RFC). This works today with single-config runs and
 * auto-extends when Phase 3's multi-config lands.
 */

import type { EvalIteration } from "./types";
import { computeExecutionConfigKey } from "@/shared/eval-config";

const DEFAULT_REGRESSION_THRESHOLD_PCT = 10;

/**
 * Stable execution-config key for an iteration. Prefers backend-supplied
 * `hostConfigId` when present, falls back to the testCaseSnapshot's
 * provider+model so the key works in single-config runs today.
 */
export function executionConfigKeyForIteration(
  iteration: Pick<EvalIteration, "testCaseSnapshot"> & {
    hostConfigId?: string | null;
  },
): string {
  const snapshot = iteration.testCaseSnapshot;
  const hostConfigId =
    iteration.hostConfigId ??
    // Until backend hostConfigId reaches the client type, fall back to a
    // stable per-iteration model identifier. Phase 3b will replace this.
    `${snapshot?.provider ?? ""}|${snapshot?.model ?? ""}`;
  return computeExecutionConfigKey({
    hostConfigId,
    provider: snapshot?.provider,
    // testCaseSnapshot does not currently carry a toolChoice; once Phase
    // 3 wires it through the snapshot, this helper picks it up
    // automatically.
    toolChoice: undefined,
  });
}

type IterationGroupKey = string; // `${testCaseId}::${executionConfigKey}`

type IterationGroupStats = {
  testCaseId: string;
  executionConfigKey: string;
  total: number;
  passed: number;
  passRate: number; // 0..1
};

function groupKey(testCaseId: string, executionConfigKey: string): IterationGroupKey {
  return `${testCaseId}::${executionConfigKey}`;
}

function aggregateIterations(
  iterations: EvalIteration[],
): Map<IterationGroupKey, IterationGroupStats> {
  const map = new Map<IterationGroupKey, IterationGroupStats>();
  for (const it of iterations) {
    if (!it.testCaseId) continue;
    if (it.status !== "completed") continue;
    const ekey = executionConfigKeyForIteration(it);
    const k = groupKey(it.testCaseId, ekey);
    const prev = map.get(k);
    const passed = it.result === "passed" ? 1 : 0;
    if (prev) {
      prev.total += 1;
      prev.passed += passed;
    } else {
      map.set(k, {
        testCaseId: it.testCaseId,
        executionConfigKey: ekey,
        total: 1,
        passed,
        passRate: 0, // computed below
      });
    }
  }
  for (const stats of map.values()) {
    stats.passRate = stats.total > 0 ? stats.passed / stats.total : 0;
  }
  return map;
}

export type SuiteRegressionEntry = {
  testCaseId: string;
  executionConfigKey: string;
  previousPassRate: number; // 0..1
  currentPassRate: number; // 0..1
  /**
   * `previousPassRate - currentPassRate`. Positive means current is worse
   * (regression). Negative means current improved.
   */
  drop: number;
  /** True iff `drop * 100 > thresholdPct` (strictly greater than). */
  exceededThreshold: boolean;
  currentTotal: number;
  previousTotal: number;
};

export type SuiteRegressionReport = {
  thresholdPct: number;
  /** Pairs present in BOTH runs, with their pass-rate delta. */
  comparable: SuiteRegressionEntry[];
  /** `(testCaseId, executionConfigKey)` pairs only in the current run. */
  addedPairs: Array<{ testCaseId: string; executionConfigKey: string }>;
  /** Pairs only in the prior run (removed/skipped). */
  removedPairs: Array<{ testCaseId: string; executionConfigKey: string }>;
  /** Convenience: count of comparable pairs that exceeded threshold. */
  regressedCount: number;
};

/**
 * Compute the regression report between two runs' iteration lists.
 *
 * Both inputs should be the COMPLETED iterations for a single
 * `testSuiteRun` (caller filters by `suiteRunId`). The helper itself
 * ignores non-completed iterations defensively.
 */
export function computeSuiteRegression(
  currentIterations: EvalIteration[],
  previousIterations: EvalIteration[],
  thresholdPct: number = DEFAULT_REGRESSION_THRESHOLD_PCT,
): SuiteRegressionReport {
  const currentGroups = aggregateIterations(currentIterations);
  const previousGroups = aggregateIterations(previousIterations);

  const comparable: SuiteRegressionEntry[] = [];
  const addedPairs: SuiteRegressionReport["addedPairs"] = [];
  const removedPairs: SuiteRegressionReport["removedPairs"] = [];

  for (const [k, cur] of currentGroups) {
    const prev = previousGroups.get(k);
    if (!prev) {
      addedPairs.push({
        testCaseId: cur.testCaseId,
        executionConfigKey: cur.executionConfigKey,
      });
      continue;
    }
    const drop = prev.passRate - cur.passRate;
    comparable.push({
      testCaseId: cur.testCaseId,
      executionConfigKey: cur.executionConfigKey,
      previousPassRate: prev.passRate,
      currentPassRate: cur.passRate,
      drop,
      exceededThreshold: drop * 100 > thresholdPct,
      currentTotal: cur.total,
      previousTotal: prev.total,
    });
  }

  for (const [k, prev] of previousGroups) {
    if (currentGroups.has(k)) continue;
    removedPairs.push({
      testCaseId: prev.testCaseId,
      executionConfigKey: prev.executionConfigKey,
    });
  }

  const regressedCount = comparable.filter((e) => e.exceededThreshold).length;

  return {
    thresholdPct,
    comparable,
    addedPairs,
    removedPairs,
    regressedCount,
  };
}
