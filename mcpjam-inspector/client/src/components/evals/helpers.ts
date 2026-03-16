import {
  CommitGroup,
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteOverviewEntry,
  EvalSuiteRun,
  SuiteAggregate,
  TagGroupAggregate,
} from "./types";
import { computeIterationResult } from "./pass-criteria";
import { toast } from "sonner";
import { RESULT_STATUS } from "./constants";

export function formatTime(ts?: number) {
  return ts ? new Date(ts).toLocaleString() : "—";
}

export function formatDuration(durationMs: number) {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function formatRunId(runId: string): string {
  // Format Convex ID for display (e.g., "j1234567890abcdef" -> "j1234567")
  return runId.substring(0, 8);
}

/**
 * Compute summary statistics for a list of iterations
 */
export function computeIterationSummary(items: EvalIteration[]) {
  const summary = {
    runs: items.length,
    passed: 0,
    failed: 0,
    cancelled: 0,
    pending: 0,
    tokens: 0,
    avgDuration: null as number | null,
  };

  let totalDuration = 0;
  let durationCount = 0;

  items.forEach((iteration) => {
    if (iteration.result === "passed") summary.passed += 1;
    else if (iteration.result === "failed") summary.failed += 1;
    else if (iteration.result === "cancelled") summary.cancelled += 1;
    else summary.pending += 1;

    summary.tokens += iteration.tokensUsed || 0;

    const startedAt = iteration.startedAt ?? iteration.createdAt;
    const completedAt = iteration.updatedAt ?? iteration.createdAt;
    if (startedAt && completedAt) {
      const duration = Math.max(completedAt - startedAt, 0);
      totalDuration += duration;
      durationCount += 1;
    }
  });

  if (durationCount > 0) {
    summary.avgDuration = totalDuration / durationCount;
  }

  return summary;
}

/**
 * Get the template key for a test case or config test
 * Falls back to a unique identifier if no explicit template key exists
 */
export function getTemplateKey(test: {
  testTemplateKey?: string;
  title?: string;
  query?: string;
  _id?: string;
}): string {
  if (test.testTemplateKey) return test.testTemplateKey;
  if (test._id) return `fallback:${test._id}`;
  return `fallback:${test.title}-${test.query}`;
}

export function aggregateSuite(
  suite: EvalSuite,
  cases: EvalCase[],
  iterations: EvalIteration[],
): SuiteAggregate {
  // Backend already filters iterations by suite, so we use them directly
  const totals = iterations.reduce(
    (acc, it) => {
      const result = computeIterationResult(it);
      if (result === "pending") {
        acc.pending += 1;
      } else if (result === "passed") {
        acc.passed += 1;
      } else if (result === "failed") {
        acc.failed += 1;
      } else if (result === "cancelled") {
        acc.cancelled += 1;
      }
      acc.tokens += it.tokensUsed || 0;
      return acc;
    },
    { passed: 0, failed: 0, cancelled: 0, pending: 0, tokens: 0 },
  );

  const byCaseMap = new Map<string, SuiteAggregate["byCase"][number]>();
  for (const it of iterations) {
    const id = it.testCaseId;
    if (!id) continue;
    if (!byCaseMap.has(id)) {
      const c = cases.find((x) => x._id === id);
      // Count total iterations for this test case
      const totalRuns = iterations.filter(
        (iter) => iter.testCaseId === id,
      ).length;
      byCaseMap.set(id, {
        testCaseId: id,
        title: c?.title || "Untitled",
        provider: c?.provider || "",
        model: c?.model || "",
        runs: totalRuns,
        passed: 0,
        failed: 0,
        cancelled: 0,
        tokens: 0,
      });
    }
    const entry = byCaseMap.get(id)!;
    const result = computeIterationResult(it);
    if (result === "pending") {
      // do not count pending/running
    } else if (result === "passed") {
      entry.passed += 1;
    } else if (result === "failed") {
      entry.failed += 1;
    } else if (result === "cancelled") {
      entry.cancelled += 1;
    }
    entry.tokens += it.tokensUsed || 0;
  }

  return {
    filteredIterations: iterations,
    totals,
    byCase: Array.from(byCaseMap.values()),
  };
}

/**
 * Centralized error handling for mutations
 */
export function handleMutationError(error: unknown, action: string) {
  console.error(`Failed to ${action}:`, error);
  toast.error(error instanceof Error ? error.message : `Failed to ${action}`);
}

/**
 * Centralized success toast
 */
export function handleMutationSuccess(message: string) {
  toast.success(message);
}

/**
 * Format a percentage
 */
export function formatPercentage(value: number): string {
  return `${Math.round(value)}%`;
}

/**
 * Format token count
 */
export function formatTokens(tokens: number): string {
  return tokens > 0 ? tokens.toLocaleString() : "—";
}

/**
 * Get border color based on result status
 */
export function getIterationBorderColor(result: string): string {
  switch (result) {
    case RESULT_STATUS.PASSED:
      return "bg-success/50";
    case RESULT_STATUS.FAILED:
      return "bg-red-500/50";
    case RESULT_STATUS.CANCELLED:
      return "bg-muted";
    case RESULT_STATUS.PENDING:
      return "bg-warning/50";
    default:
      return "bg-muted-foreground/50";
  }
}

/**
 * Get status dot color
 */
export function getStatusDotColor(result: string, status?: string): string {
  if (result === RESULT_STATUS.PASSED) return "bg-success";
  if (result === RESULT_STATUS.FAILED) return "bg-destructive";
  if (result === RESULT_STATUS.CANCELLED) return "bg-muted-foreground";
  if (result === RESULT_STATUS.PENDING || status === "pending")
    return "bg-warning";
  if (status === "running") return "bg-warning";
  return "bg-muted-foreground";
}

/**
 * Formatters object for convenient access
 */
export const formatters = {
  time: formatTime,
  duration: formatDuration,
  runId: formatRunId,
  percentage: formatPercentage,
  tokens: formatTokens,
} as const;

/**
 * Flatten recentRuns across all suites and group by commitSha.
 * Runs without a commitSha go into a "manual" group.
 */
export function groupRunsByCommit(
  overview: EvalSuiteOverviewEntry[],
): CommitGroup[] {
  const buckets = new Map<string, { runs: EvalSuiteRun[]; suiteMap: Map<string, string> }>();

  for (const entry of overview) {
    for (const run of entry.recentRuns) {
      const sha = run.ciMetadata?.commitSha?.trim() || "__manual__";
      if (!buckets.has(sha)) {
        buckets.set(sha, { runs: [], suiteMap: new Map() });
      }
      const bucket = buckets.get(sha)!;
      bucket.runs.push(run);
      bucket.suiteMap.set(entry.suite._id, entry.suite.name);
    }
  }

  const groups: CommitGroup[] = [];
  for (const [sha, { runs, suiteMap }] of buckets) {
    const isManual = sha === "__manual__";
    const summary = { total: runs.length, passed: 0, failed: 0, running: 0 };
    let latestTimestamp = 0;
    let branch: string | null = null;

    for (const run of runs) {
      const ts = run.completedAt ?? run.createdAt;
      if (ts > latestTimestamp) latestTimestamp = ts;
      if (!branch && run.ciMetadata?.branch) branch = run.ciMetadata.branch;
      if (run.status === "running" || run.status === "pending") summary.running++;
      else if (run.result === "passed") summary.passed++;
      else if (run.result === "failed") summary.failed++;
    }

    let status: CommitGroup["status"];
    if (summary.running > 0) status = "running";
    else if (summary.failed > 0 && summary.passed > 0) status = "mixed";
    else if (summary.failed > 0) status = "failed";
    else status = "passed";

    groups.push({
      commitSha: isManual ? "manual" : sha,
      shortSha: isManual ? "Manual" : sha.slice(0, 7),
      branch: isManual ? null : branch,
      timestamp: latestTimestamp,
      status,
      runs,
      suiteMap,
      summary,
    });
  }

  // Sort by most recent first, manual always last
  groups.sort((a, b) => {
    if (a.commitSha === "manual") return 1;
    if (b.commitSha === "manual") return -1;
    return b.timestamp - a.timestamp;
  });

  return groups;
}

/**
 * Format relative time for sidebar display
 */
export function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return "No runs yet";
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Group overview entries by tag and compute aggregated stats per tag.
 */
export function groupSuitesByTag(
  overview: EvalSuiteOverviewEntry[],
): TagGroupAggregate[] {
  const buckets = new Map<string, EvalSuiteOverviewEntry[]>();

  for (const entry of overview) {
    const tags = entry.suite.tags;
    if (!tags || tags.length === 0) {
      const bucket = buckets.get("Untagged") ?? [];
      bucket.push(entry);
      buckets.set("Untagged", bucket);
    } else {
      for (const tag of tags) {
        const bucket = buckets.get(tag) ?? [];
        bucket.push(entry);
        buckets.set(tag, bucket);
      }
    }
  }

  const groups: TagGroupAggregate[] = [];
  for (const [tag, entries] of buckets) {
    const totals = { passed: 0, failed: 0, runs: 0 };
    for (const e of entries) {
      totals.passed += e.totals.passed;
      totals.failed += e.totals.failed;
      totals.runs += e.totals.runs;
    }
    const total = totals.passed + totals.failed;
    groups.push({
      tag,
      suiteCount: entries.length,
      totals,
      passRate: total > 0 ? Math.round((totals.passed / total) * 100) : 0,
      entries,
    });
  }

  // Sort alphabetically, "Untagged" last
  groups.sort((a, b) => {
    if (a.tag === "Untagged") return 1;
    if (b.tag === "Untagged") return -1;
    return a.tag.localeCompare(b.tag);
  });

  return groups;
}
