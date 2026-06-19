import { percentile } from "./helpers";
import {
  computeIterationResult,
} from "./pass-criteria";
import type { EvalIteration } from "./types";

export type RunCaseIterationOutcome = "pass" | "fail" | "pending" | "cancelled";

export type RunCaseGroup = {
  /** Stable group key: testCaseId or title fallback. */
  key: string;
  testCaseId: string | null;
  title: string;
  model: string;
  iterations: EvalIteration[];
  passed: number;
  failed: number;
  pending: number;
  cancelled: number;
  total: number;
  p50Ms: number | null;
  p95Ms: number | null;
  iterationResults: RunCaseIterationOutcome[];
};

function iterationDurationMs(iteration: EvalIteration): number | null {
  const startedAt = iteration.startedAt ?? iteration.createdAt;
  const completedAt = iteration.updatedAt ?? iteration.createdAt;
  if (
    typeof startedAt !== "number" ||
    typeof completedAt !== "number" ||
    iteration.result === "pending"
  ) {
    return null;
  }
  return Math.max(completedAt - startedAt, 0);
}

function iterationOutcome(iteration: EvalIteration): RunCaseIterationOutcome {
  const result = computeIterationResult(iteration);
  if (result === "passed") return "pass";
  if (result === "failed" || result === "timed_out") return "fail";
  if (result === "cancelled") return "cancelled";
  return "pending";
}

function groupKeyForIteration(iteration: EvalIteration): string {
  if (iteration.testCaseId) return iteration.testCaseId;
  return `title:${iteration.testCaseSnapshot?.title ?? "Unknown"}`;
}

export function groupRunIterationsByTestCase(
  iterations: EvalIteration[],
  sortBy: "model" | "test" | "result" = "test",
): RunCaseGroup[] {
  const map = new Map<string, RunCaseGroup>();

  for (const iteration of iterations) {
    const key = groupKeyForIteration(iteration);
    const title = iteration.testCaseSnapshot?.title ?? "Unknown";
    const model = iteration.testCaseSnapshot?.model ?? "—";

    if (!map.has(key)) {
      map.set(key, {
        key,
        testCaseId: iteration.testCaseId ?? null,
        title,
        model,
        iterations: [],
        passed: 0,
        failed: 0,
        pending: 0,
        cancelled: 0,
        total: 0,
        p50Ms: null,
        p95Ms: null,
        iterationResults: [],
      });
    }

    const group = map.get(key)!;
    group.iterations.push(iteration);
    group.iterationResults.push(iterationOutcome(iteration));

    // Bucket on the same normalized result that drives iterationResults, so the
    // visual bar and the numeric counts can never disagree.
    const result = computeIterationResult(iteration);
    if (result === "passed") group.passed += 1;
    else if (result === "failed" || result === "timed_out") group.failed += 1;
    else if (result === "cancelled") group.cancelled += 1;
    else group.pending += 1;
    group.total += 1;
  }

  const groups = Array.from(map.values()).map((group) => {
    const durations = group.iterations
      .map(iterationDurationMs)
      .filter((value): value is number => value !== null);
    return {
      ...group,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
    };
  });

  return sortRunCaseGroups(groups, sortBy);
}

function sortRunCaseGroups(
  groups: RunCaseGroup[],
  sortBy: "model" | "test" | "result",
): RunCaseGroup[] {
  if (sortBy === "model") {
    return [...groups].sort(
      (a, b) =>
        a.model.localeCompare(b.model) || a.title.localeCompare(b.title),
    );
  }

  if (sortBy === "result") {
    const rank = (group: RunCaseGroup) => {
      if (group.failed > 0) return 0;
      if (group.pending > 0) return 1;
      if (group.passed > 0 && group.failed === 0) return 2;
      return 3;
    };
    return [...groups].sort(
      (a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title),
    );
  }

  return [...groups].sort((a, b) => a.title.localeCompare(b.title));
}

export function formatRunCaseLatencyMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
}
