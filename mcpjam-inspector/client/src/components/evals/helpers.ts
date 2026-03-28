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
import { getBillingErrorMessage } from "@/lib/billing-entitlements";

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
 * Sort Explore cases: failures first, then "warning" tier (pending/running, no result yet,
 * cancelled-only, or negative tests), then passes. Ties break by title.
 */
export function sortExploreCasesBySignal(
  cases: EvalCase[],
  aggregate: SuiteAggregate | null,
  iterations: EvalIteration[],
): EvalCase[] {
  const byCaseId = new Map(
    aggregate?.byCase.map((row) => [row.testCaseId, row]) ?? [],
  );

  const latestIterationForCase = (
    testCaseId: string,
  ): EvalIteration | undefined => {
    const forCase = iterations.filter((i) => i.testCaseId === testCaseId);
    if (forCase.length === 0) return undefined;
    return forCase.reduce((a, b) =>
      (a.updatedAt ?? 0) >= (b.updatedAt ?? 0) ? a : b,
    );
  };

  const signalRank = (c: EvalCase): number => {
    const row = byCaseId.get(c._id);
    if (row && row.failed > 0) return 0;

    const latest = latestIterationForCase(c._id);
    if (!latest) return 1;

    const computed = computeIterationResult(latest);
    if (computed === "failed") return 0;
    if (computed === "pending") return 1;
    if (computed === "cancelled") return 1;
    if (c.isNegativeTest) return 1;
    return 2;
  };

  return [...cases].sort((a, b) => {
    const ra = signalRank(a);
    const rb = signalRank(b);
    if (ra !== rb) return ra - rb;
    return (a.title || "").localeCompare(b.title || "");
  });
}

/**
 * Centralized error handling for mutations
 */
export function handleMutationError(error: unknown, action: string) {
  console.error(`Failed to ${action}:`, error);
  toast.error(getBillingErrorMessage(error, `Failed to ${action}`));
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
 * Left `border-l-2` accents — parity with pre–#1602 `getIterationBorderColor` stripes
 * (`bg-success/50`, `bg-destructive/50`, `bg-warning/50`, …).
 */
export function evalStatusLeftBorderClasses(result: string): string {
  switch (result) {
    case RESULT_STATUS.PASSED:
      return "border-l-success/50";
    case RESULT_STATUS.FAILED:
      return "border-l-destructive/50";
    case RESULT_STATUS.PENDING:
    case "running":
      return "border-l-warning/50";
    case RESULT_STATUS.CANCELLED:
      return "border-l-muted";
    case "mixed":
      return "border-l-warning/50";
    default:
      return "border-l-muted-foreground/50";
  }
}

/**
 * Thin vertical strip fills — same opacity/hue as {@link evalStatusLeftBorderClasses}
 * (`bg-success/50`, `bg-destructive/50`, `bg-warning/50`) so nested rows match parent rails.
 */
export function evalStatusMiniBarClasses(result: string): string {
  switch (result) {
    case RESULT_STATUS.PASSED:
      return "bg-success/50";
    case RESULT_STATUS.FAILED:
      return "bg-destructive/50";
    case RESULT_STATUS.PENDING:
    case "running":
      return "bg-warning/50 animate-pulse";
    case RESULT_STATUS.CANCELLED:
      return "bg-muted-foreground/40";
    case "mixed":
      return "bg-warning/50";
    default:
      return "bg-muted-foreground/40";
  }
}

/** Left `border-l-*` for a suite overview row from `latestRun`. */
export function evalOverviewEntryLeftBorderClass(
  entry: EvalSuiteOverviewEntry,
): string {
  const r = entry.latestRun;
  if (!r) return "border-l-transparent";
  if (r.status === "running" || r.status === "pending") {
    return evalStatusLeftBorderClasses(RESULT_STATUS.PENDING);
  }
  if (r.result === "passed") {
    return evalStatusLeftBorderClasses(RESULT_STATUS.PASSED);
  }
  if (r.result === "failed") {
    return evalStatusLeftBorderClasses(RESULT_STATUS.FAILED);
  }
  return "border-l-muted-foreground/35";
}

export function evalOverviewEntryMiniBarClass(
  entry: EvalSuiteOverviewEntry,
): string {
  const r = entry.latestRun;
  if (!r) return "bg-muted-foreground/25";
  if (r.status === "running" || r.status === "pending") {
    return "bg-warning/50 animate-pulse";
  }
  if (r.result === "passed") {
    return "bg-success/50";
  }
  if (r.result === "failed") return "bg-destructive/50";
  return "bg-muted-foreground/40";
}

/**
 * Selected nested suite row — borders use the same `/50` rails as the parent
 * {@link evalOverviewEntryLeftBorderClass}.
 */
/** Selected nested row: inset ring + tint so left status border stays the outcome rail. */
export function evalOverviewEntrySelectedRowClass(
  entry: EvalSuiteOverviewEntry,
): string {
  const r = entry.latestRun;
  if (!r) {
    return "bg-primary/10 ring-2 ring-primary/35 ring-inset";
  }
  if (r.status === "running" || r.status === "pending") {
    return "bg-warning/10 ring-2 ring-warning/40 ring-inset";
  }
  if (r.result === "passed") {
    return "bg-success/10 ring-2 ring-success/40 ring-inset";
  }
  if (r.result === "failed") {
    return "bg-destructive/10 ring-2 ring-destructive/35 ring-inset";
  }
  return "bg-primary/10 ring-2 ring-primary/35 ring-inset";
}

export function evalOverviewEntryOutcomeTitle(
  entry: EvalSuiteOverviewEntry,
): string {
  const r = entry.latestRun;
  if (!r) return "No runs yet";
  if (r.status === "running" || r.status === "pending") {
    return "Run in progress";
  }
  if (r.result === "passed") return "Last run passed";
  if (r.result === "failed") return "Last run failed";
  return `Last run: ${r.status}`;
}

/** Short status label for compact list rows (sidebar). */
export function evalOverviewEntryLastRunStatusLabel(
  entry: EvalSuiteOverviewEntry,
): string {
  const r = entry.latestRun;
  if (!r) return "No runs yet";
  if (r.status === "running" || r.status === "pending") return "Running";
  if (r.result === "passed") return "Passed";
  if (r.result === "failed" || r.status === "failed") return "Failed";
  if (r.result === "cancelled" || r.status === "cancelled") {
    return "Cancelled";
  }
  if (r.status === "completed") return "Completed";
  return r.status.replace(/-/g, " ");
}

/** Tailwind classes for {@link evalOverviewEntryLastRunStatusLabel}. */
export function evalOverviewEntryLastRunStatusClass(
  entry: EvalSuiteOverviewEntry,
): string {
  const r = entry.latestRun;
  if (!r) return "text-muted-foreground";
  if (r.status === "running" || r.status === "pending") {
    return "text-amber-600 dark:text-amber-400";
  }
  if (r.result === "passed") return "text-success";
  if (r.result === "failed" || r.status === "failed") {
    return "text-destructive";
  }
  if (r.result === "cancelled" || r.status === "cancelled") {
    return "text-muted-foreground";
  }
  return "text-muted-foreground";
}

/** Normalize API trend points (0–1 or 0–100) to 0–100 integers. */
export function toPercentEvalTrend(value: number): number {
  const normalized = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

export const SUITE_PASS_RATE_TREND_VISIBLE_SEGMENTS = 12;

/** When history is longer than this, show a “+N” badge with a tooltip of older points. */
export const SUITE_PASS_RATE_TREND_BADGE_THRESHOLD = 16;

export type SuitePassRateTrendDisplay = {
  percents: number[];
  olderHiddenCount: number;
  showOlderRunsBadge: boolean;
  summaryLabel: string;
  olderPercentsTooltip: string | null;
};

/**
 * Prepare pass-rate trend for sidebar sparklines: last N segments, optional overflow badge, summary text.
 */
export function formatSuitePassRateTrendForDisplay(
  rawTrend: number[] | undefined | null,
): SuitePassRateTrendDisplay | null {
  if (!rawTrend?.length) return null;
  const len = rawTrend.length;
  const slice = rawTrend.slice(-SUITE_PASS_RATE_TREND_VISIBLE_SEGMENTS);
  const percents = slice.map(toPercentEvalTrend);
  const olderHiddenCount = Math.max(
    0,
    len - SUITE_PASS_RATE_TREND_VISIBLE_SEGMENTS,
  );
  const showOlderRunsBadge = len > SUITE_PASS_RATE_TREND_BADGE_THRESHOLD;
  let good = 0;
  for (const p of percents) {
    if (p >= 80) good += 1;
  }
  const worst = Math.min(...percents);
  const summaryLabel =
    percents.length >= 3
      ? `${good}/${percents.length} ≥80% · min ${worst}%`
      : "";
  const olderSlice =
    olderHiddenCount > 0
      ? rawTrend
          .slice(0, len - SUITE_PASS_RATE_TREND_VISIBLE_SEGMENTS)
          .map(toPercentEvalTrend)
      : [];
  const olderPercentsTooltip =
    olderSlice.length > 0
      ? `Earlier runs (pass rate %): ${olderSlice.join(", ")}`
      : null;
  return {
    percents,
    olderHiddenCount,
    showOlderRunsBadge,
    summaryLabel,
    olderPercentsTooltip,
  };
}

/**
 * Background class for legacy `w-1` strips (pre–#1602 iteration rows).
 */
export function getIterationBorderColor(result: string): string {
  switch (result) {
    case RESULT_STATUS.PASSED:
      return "bg-success/50";
    case RESULT_STATUS.FAILED:
      return "bg-destructive/50";
    case RESULT_STATUS.CANCELLED:
      return "bg-muted";
    case RESULT_STATUS.PENDING:
    case "running":
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
  const buckets = new Map<
    string,
    { runs: EvalSuiteRun[]; suiteMap: Map<string, string> }
  >();

  for (const entry of overview) {
    for (const run of entry.recentRuns) {
      const sha = run.ciMetadata?.commitSha?.trim() || "";
      // Each manual run (no commit SHA) gets its own group keyed by run ID
      const key = sha || `__manual__${run._id}`;
      if (!buckets.has(key)) {
        buckets.set(key, { runs: [], suiteMap: new Map() });
      }
      const bucket = buckets.get(key)!;
      bucket.runs.push(run);
      bucket.suiteMap.set(entry.suite._id, entry.suite.name);
    }
  }

  const groups: CommitGroup[] = [];
  for (const [key, { runs, suiteMap }] of buckets) {
    const isManual = key.startsWith("__manual__");
    const summary = { total: runs.length, passed: 0, failed: 0, running: 0 };
    let latestTimestamp = 0;
    let branch: string | null = null;

    for (const run of runs) {
      const ts = run.completedAt ?? run.createdAt;
      if (ts > latestTimestamp) latestTimestamp = ts;
      if (!branch && run.ciMetadata?.branch) branch = run.ciMetadata.branch;
      if (run.status === "running" || run.status === "pending")
        summary.running++;
      else if (run.result === "passed") summary.passed++;
      else if (run.result === "failed") summary.failed++;
    }

    let status: CommitGroup["status"];
    if (summary.running > 0) status = "running";
    else if (summary.failed > 0 && summary.passed > 0) status = "mixed";
    else if (summary.failed > 0) status = "failed";
    else status = "passed";

    // For manual runs, use a unique ID so each gets its own page
    const manualId = isManual ? key.replace("__manual__", "manual-") : null;

    groups.push({
      commitSha: isManual ? manualId! : key,
      shortSha: isManual ? "Manual" : key.slice(0, 7),
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
    if (a.commitSha.startsWith("manual-")) return 1;
    if (b.commitSha.startsWith("manual-")) return -1;
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
