import { cn } from "@/lib/utils";
import type { EvalSuiteOverviewEntry } from "./types";

interface CiSuiteListSidebarProps {
  suites: EvalSuiteOverviewEntry[];
  selectedSuiteId: string | null;
  onSelectSuite: (suiteId: string) => void;
  isLoading?: boolean;
}

function getStatusDot(entry: EvalSuiteOverviewEntry): {
  label: string;
  dotClass: string;
} {
  const latestRun = entry.latestRun;
  if (!latestRun) {
    return { label: "No runs", dotClass: "bg-muted-foreground/40" };
  }
  if (latestRun.status === "running" || latestRun.status === "pending") {
    return { label: "Running", dotClass: "bg-blue-500 animate-pulse" };
  }
  if (latestRun.result === "passed") {
    return { label: "Passed", dotClass: "bg-emerald-500" };
  }
  if (latestRun.result === "failed") {
    return { label: "Failed", dotClass: "bg-destructive" };
  }
  return { label: latestRun.status, dotClass: "bg-muted-foreground/40" };
}

function toPercent(value: number): number {
  const normalized = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

function formatRelativeTime(timestamp?: number): string {
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

export function CiSuiteListSidebar({
  suites,
  selectedSuiteId,
  onSelectSuite,
  isLoading = false,
}: CiSuiteListSidebarProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Eval suites</h2>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            Loading suites...
          </div>
        ) : suites.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            No SDK suites found.
          </div>
        ) : (
          <div>
            {suites.map((entry) => {
              const latestRun = entry.latestRun;
              const status = getStatusDot(entry);
              const trend = entry.passRateTrend
                .slice(-12)
                .map((value) => toPercent(value));
              const timestamp = formatRelativeTime(
                latestRun?.completedAt ??
                  latestRun?.createdAt ??
                  entry.suite.updatedAt,
              );

              return (
                <button
                  key={entry.suite._id}
                  onClick={() => onSelectSuite(entry.suite._id)}
                  className={cn(
                    "w-full px-4 py-2.5 text-left transition-colors hover:bg-accent/50",
                    selectedSuiteId === entry.suite._id && "bg-accent",
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <div
                      className={cn("h-2 w-2 shrink-0 rounded-full", status.dotClass)}
                      title={status.label}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {entry.suite.name || "Untitled suite"}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {timestamp}
                      </div>
                    </div>
                    {trend.length > 0 && (
                      <div className="flex h-5 shrink-0 items-end gap-px">
                        {trend.map((value, idx) => (
                          <div
                            key={`${entry.suite._id}-t-${idx}`}
                            className="w-1 rounded-sm bg-primary/70"
                            style={{ height: `${Math.max(3, (value / 100) * 20)}px` }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
