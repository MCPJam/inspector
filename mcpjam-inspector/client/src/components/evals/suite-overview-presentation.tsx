import {
  CheckCircle2,
  Loader2,
  MinusCircle,
  TrendingDown,
  TrendingUp,
  XCircle,
} from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@/lib/utils";
import type { EvalSuiteOverviewEntry } from "./types";
import {
  EVAL_FAIL_BAR_CLASS,
  EVAL_LOW_PASS_RATE_TEXT_CLASS,
} from "./constants";

/** Strip trailing timestamp suffixes from suite names for display. */
export function stripTimestampSuffix(name: string): string {
  return name.replace(/\s*\(\d{4}-\d{2}-\d{2}[^)]*\)\s*$/, "").trim() || name;
}

export function toPercent(value: number): number {
  const n = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function formatOverviewRelativeTime(timestamp?: number): string {
  if (!timestamp) return "";
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

export type SuitePassRateDelta = {
  value: number | null;
  label: string;
  colorClass: string;
};

export function computeSuitePassRateDelta(
  entry: EvalSuiteOverviewEntry,
): SuitePassRateDelta {
  const trend = entry.passRateTrend;
  if (!entry.latestRun) {
    return { value: null, label: "—", colorClass: "text-muted-foreground" };
  }
  if (trend.length < 2) {
    return { value: null, label: "NEW", colorClass: "text-info" };
  }
  const delta = Math.round(
    (trend[trend.length - 1] - trend[trend.length - 2]) * 100,
  );
  if (delta === 0) {
    return { value: 0, label: "+0%", colorClass: "text-muted-foreground" };
  }
  return {
    value: delta,
    label: `${delta > 0 ? "+" : ""}${delta}%`,
    colorClass: delta > 0 ? "text-success" : EVAL_LOW_PASS_RATE_TEXT_CLASS,
  };
}

export function getSuitePassRatePercent(
  entry: EvalSuiteOverviewEntry,
): number | null {
  if (entry.latestRun?.summary) {
    const { passRate, passed, total } = entry.latestRun.summary;
    if (typeof passRate === "number") {
      return toPercent(passRate);
    }
    if (total > 0) {
      return Math.round((passed / total) * 100);
    }
  }
  const total = entry.totals.passed + entry.totals.failed;
  if (total === 0) return null;
  return Math.round((entry.totals.passed / total) * 100);
}

/** Legacy string label used by overview-panel table. */
export function getSuitePassRateLabel(entry: EvalSuiteOverviewEntry): string {
  const pct = getSuitePassRatePercent(entry);
  if (pct === null) return "--";
  return `${pct}%`;
}

export function getSuitePassFailCounts(
  entry: EvalSuiteOverviewEntry,
): { passed: number; total: number } | null {
  if (entry.latestRun?.summary && entry.latestRun.summary.total > 0) {
    return {
      passed: entry.latestRun.summary.passed,
      total: entry.latestRun.summary.total,
    };
  }
  const total = entry.totals.passed + entry.totals.failed;
  if (total === 0) return null;
  return { passed: entry.totals.passed, total };
}

export function passRateColorClass(percent: number | null): string {
  if (percent === null) return "text-muted-foreground";
  if (percent >= 95) return "text-success";
  if (percent >= 75) return "text-warning";
  return EVAL_LOW_PASS_RATE_TEXT_CLASS;
}

/** Segment fills for pass-rate bars — thresholds aligned with {@link passRateColorClass}. */
export function passRateSegmentColorClass(percent: number | null): string {
  if (percent === null) return "bg-muted-foreground/15";
  if (percent >= 95) return "bg-success/50";
  if (percent >= 75) return "bg-warning/50";
  return EVAL_FAIL_BAR_CLASS;
}

export function Sparkline({
  data,
  className,
}: {
  data: number[];
  className?: string;
}) {
  if (data.length === 0) return null;
  return (
    <div
      className={cn("flex h-4 items-end gap-px", className)}
      aria-hidden
      data-testid="suite-pass-rate-sparkline"
    >
      {data.map((value, idx) => (
        <div
          key={idx}
          className="w-1.5 rounded-sm bg-primary/70"
          style={{
            height: `${Math.max(3, (toPercent(value) / 100) * 100)}%`,
          }}
        />
      ))}
    </div>
  );
}

export function SuiteOverviewStatusIcon({
  entry,
  className,
}: {
  entry: EvalSuiteOverviewEntry;
  className?: string;
}) {
  const iconClass = cn("h-4 w-4 shrink-0", className);
  if (!entry.latestRun) {
    return <MinusCircle className={cn(iconClass, "text-muted-foreground")} />;
  }
  if (
    entry.latestRun.status === "running" ||
    entry.latestRun.status === "pending"
  ) {
    return (
      <Loader2
        className={cn(iconClass, "animate-spin text-warning")}
        aria-label="Running"
      />
    );
  }
  if (entry.latestRun.result === "passed") {
    return (
      <CheckCircle2
        className={cn(iconClass, "text-success")}
        aria-label="Passed"
      />
    );
  }
  if (entry.latestRun.result === "failed") {
    return (
      <XCircle
        className={cn(iconClass, "text-destructive")}
        aria-label="Failed"
      />
    );
  }
  return <MinusCircle className={cn(iconClass, "text-muted-foreground")} />;
}

export function SuitePassRateDeltaChip({
  delta,
}: {
  delta: SuitePassRateDelta;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 text-xs font-medium tabular-nums",
        delta.colorClass,
      )}
    >
      {delta.value !== null && delta.value !== 0 ? (
        delta.value > 0 ? (
          <TrendingUp className="h-3 w-3" aria-hidden />
        ) : (
          <TrendingDown className="h-3 w-3" aria-hidden />
        )
      ) : null}
      {delta.label}
    </span>
  );
}

export function SuiteSourceBadge({ source }: { source?: "ui" | "sdk" }) {
  if (source !== "sdk") return null;
  return (
    <Badge
      variant="outline"
      className="shrink-0 px-1.5 py-0 text-[10px] font-normal uppercase tracking-wide"
    >
      SDK
    </Badge>
  );
}

export function SuitePassFailMiniBar({
  entry,
  className,
}: {
  entry: EvalSuiteOverviewEntry;
  className?: string;
}) {
  const counts = getSuitePassFailCounts(entry);
  if (!counts) return null;
  const pct =
    counts.total > 0 ? Math.round((counts.passed / counts.total) * 100) : 0;
  return (
    <div className={cn("flex min-w-[72px] items-center gap-2", className)}>
      <div
        className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${counts.passed} of ${counts.total} passed`}
      >
        <div
          className={cn(
            "h-full rounded-full transition-all",
            pct >= 95
              ? "bg-success/50"
              : pct >= 75
                ? "bg-warning/50"
                : "bg-destructive/50",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {counts.passed}/{counts.total} passed
      </span>
    </div>
  );
}

export function formatServerChipSummary(servers: string[]): string {
  if (servers.length === 0) return "No servers";
  if (servers.length <= 2) return servers.join(", ");
  return `${servers.slice(0, 2).join(", ")} +${servers.length - 2}`;
}

export type SuiteListSortKey =
  | "severity"
  | "recently_run"
  | "pass_rate"
  | "name"
  | "most_failing";

export function suiteSeverityRank(entry: EvalSuiteOverviewEntry): number {
  if (entry.latestRun?.result === "failed") return 0;
  if (
    entry.latestRun?.status === "running" ||
    entry.latestRun?.status === "pending"
  ) {
    return 1;
  }
  if (entry.latestRun?.result === "passed") return 2;
  return 3;
}

export function sortSuiteOverviewEntries(
  entries: EvalSuiteOverviewEntry[],
  sortKey: SuiteListSortKey,
): EvalSuiteOverviewEntry[] {
  const list = [...entries];
  switch (sortKey) {
    case "recently_run":
      list.sort((a, b) => {
        const ta = a.latestRun?.completedAt ?? a.latestRun?.createdAt ?? -1;
        const tb = b.latestRun?.completedAt ?? b.latestRun?.createdAt ?? -1;
        return tb - ta;
      });
      break;
    case "pass_rate": {
      list.sort((a, b) => {
        const pa = getSuitePassRatePercent(a) ?? -1;
        const pb = getSuitePassRatePercent(b) ?? -1;
        return pb - pa;
      });
      break;
    }
    case "name":
      list.sort((a, b) =>
        stripTimestampSuffix(a.suite.name || "").localeCompare(
          stripTimestampSuffix(b.suite.name || ""),
        ),
      );
      break;
    case "most_failing":
      list.sort((a, b) => {
        const fa =
          a.latestRun?.summary?.failed ??
          a.totals.failed ??
          (a.latestRun?.result === "failed" ? 1 : 0);
        const fb =
          b.latestRun?.summary?.failed ??
          b.totals.failed ??
          (b.latestRun?.result === "failed" ? 1 : 0);
        return fb - fa;
      });
      break;
    case "severity":
    default:
      list.sort((a, b) => {
        const ra = suiteSeverityRank(a);
        const rb = suiteSeverityRank(b);
        if (ra !== rb) return ra - rb;
        return stripTimestampSuffix(a.suite.name || "").localeCompare(
          stripTimestampSuffix(b.suite.name || ""),
        );
      });
      break;
  }
  return list;
}

export function collectSuiteTags(entries: EvalSuiteOverviewEntry[]): string[] {
  const tags = new Set<string>();
  for (const entry of entries) {
    for (const tag of entry.suite.tags ?? []) {
      tags.add(tag);
    }
  }
  return [...tags].sort((a, b) => a.localeCompare(b));
}

export function computeSuiteListStats(entries: EvalSuiteOverviewEntry[]) {
  let failedCount = 0;
  let passingCount = 0;
  let runningCount = 0;
  let neverRunCount = 0;

  for (const entry of entries) {
    if (!entry.latestRun) {
      neverRunCount += 1;
      continue;
    }
    if (
      entry.latestRun.status === "running" ||
      entry.latestRun.status === "pending"
    ) {
      runningCount += 1;
      continue;
    }
    if (entry.latestRun.result === "failed") {
      failedCount += 1;
      continue;
    }
    if (entry.latestRun.result === "passed") {
      passingCount += 1;
    }
  }

  return { failedCount, passingCount, runningCount, neverRunCount };
}
