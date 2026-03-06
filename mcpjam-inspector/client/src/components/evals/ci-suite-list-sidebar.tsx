import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { EvalSuiteOverviewEntry } from "./types";
import { CiMetadataDisplay } from "./ci-metadata-display";

interface CiSuiteListSidebarProps {
  suites: EvalSuiteOverviewEntry[];
  selectedSuiteId: string | null;
  onSelectSuite: (suiteId: string) => void;
  isLoading?: boolean;
}

function toPercent(value: number): number {
  const normalized = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

function getStatusChip(entry: EvalSuiteOverviewEntry): {
  label: string;
  className: string;
} {
  const latestRun = entry.latestRun;
  if (!latestRun) {
    return {
      label: "No runs",
      className: "bg-muted text-muted-foreground border-border",
    };
  }

  if (latestRun.status === "running" || latestRun.status === "pending") {
    return {
      label: "Running",
      className: "bg-blue-500/10 text-blue-700 border-blue-300",
    };
  }

  if (latestRun.result === "passed") {
    return {
      label: "Passed",
      className: "bg-emerald-500/10 text-emerald-700 border-emerald-300",
    };
  }

  if (latestRun.result === "failed") {
    return {
      label: "Failed",
      className: "bg-destructive/10 text-destructive border-destructive/30",
    };
  }

  return {
    label: latestRun.status,
    className: "bg-muted text-muted-foreground border-border",
  };
}

function formatTimestamp(timestamp?: number): string {
  if (!timestamp) return "No runs yet";
  return new Date(timestamp).toLocaleString();
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
        <h2 className="text-sm font-semibold">CI Runs</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          SDK-ingested eval suites
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            Loading CI suites...
          </div>
        ) : suites.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            No SDK suites found.
          </div>
        ) : (
          <div className="divide-y">
            {suites.map((entry) => {
              const latestRun = entry.latestRun;
              const status = getStatusChip(entry);
              const lastTimestamp = formatTimestamp(
                latestRun?.completedAt ??
                  latestRun?.createdAt ??
                  entry.suite.updatedAt,
              );
              const trend = entry.passRateTrend
                .slice(-12)
                .map((value) => toPercent(value));
              const latestPassRate = latestRun?.summary
                ? Math.round(latestRun.summary.passRate * 100)
                : null;

              return (
                <button
                  key={entry.suite._id}
                  onClick={() => onSelectSuite(entry.suite._id)}
                  className={cn(
                    "w-full px-4 py-3 text-left transition-colors hover:bg-accent/50",
                    selectedSuiteId === entry.suite._id && "bg-accent",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {entry.suite.name || "Untitled suite"}
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {lastTimestamp}
                      </div>
                    </div>
                    <Badge variant="outline" className={status.className}>
                      {status.label}
                    </Badge>
                  </div>

                  <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
                    <span>{entry.totals.runs} runs</span>
                    <span>•</span>
                    <span>
                      {latestPassRate !== null ? `${latestPassRate}%` : "—"}{" "}
                      accuracy
                    </span>
                  </div>

                  {trend.length > 0 ? (
                    <div className="mt-2 flex h-6 items-end gap-0.5">
                      {trend.map((value, idx) => (
                        <div
                          key={`${entry.suite._id}-trend-${idx}`}
                          className="w-1 rounded-sm bg-primary/70"
                          style={{ height: `${Math.max(4, (value / 100) * 24)}px` }}
                        />
                      ))}
                    </div>
                  ) : null}

                  {latestRun && (
                    <div className="mt-2">
                      <CiMetadataDisplay
                        ciMetadata={latestRun.ciMetadata}
                        compact={true}
                      />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
