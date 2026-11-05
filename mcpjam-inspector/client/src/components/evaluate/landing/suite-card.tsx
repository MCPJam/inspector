import { useMemo } from "react";
import { formatDistanceToNow } from "date-fns";
import { Settings2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import type { EvalSuiteOverviewEntry } from "../../evals/types";
import {
  buildSuiteRunSlice,
  type SuiteSlicePoint,
  type SuiteTrend,
} from "./suite-run-slice";

interface SuiteCardProps {
  entry: EvalSuiteOverviewEntry;
  onOpenSuite: (suiteId: string) => void;
  onOpenRun: (target: { suiteId: string; runId: string }) => void;
  onOpenSettings: (suiteId: string) => void;
}

/** One suite on the Suites tab: average pass rate, trend and last five runs (C14). */
export function SuiteCard({
  entry,
  onOpenSuite,
  onOpenRun,
  onOpenSettings,
}: SuiteCardProps) {
  const { suite } = entry;
  const slice = useMemo(() => buildSuiteRunSlice(entry), [entry]);
  const { latest, average, points } = slice;
  const name = suite.name || "Untitled suite";
  const openRun = (point: SuiteSlicePoint) =>
    onOpenRun({ suiteId: suite._id, runId: point.runId });

  return (
    <li
      className="rounded-lg border border-border bg-card text-card-foreground transition-colors hover:bg-muted/30"
      data-testid="evaluate-suite-card"
    >
      <div className="grid gap-x-6 gap-y-4 p-4 md:grid-cols-[minmax(0,1.2fr)_minmax(10rem,1fr)_11rem] md:items-center">
        <button
          type="button"
          onClick={() => onOpenSuite(suite._id)}
          className="min-w-0 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              className={cn(
                "size-2 shrink-0 rounded-full",
                !latest
                  ? "bg-muted-foreground"
                  : latest.passed
                    ? "bg-success"
                    : "bg-destructive",
              )}
            />
            <span className="truncate text-sm font-semibold">{name}</span>
          </span>
          <span className="mt-3 flex items-baseline gap-2">
            <span className="text-[28px] font-semibold leading-8 tracking-tight tabular-nums">
              {average === null ? "—" : `${Math.round(average)}%`}
            </span>
            <span className="text-xs text-muted-foreground">
              {points.length === 0
                ? "No runs yet"
                : points.length === 1
                  ? "from the last run"
                  : `average of the last ${points.length} runs`}
            </span>
          </span>
        </button>
        <div className="min-w-0">
          {slice.trend ? (
            <div className="flex min-w-0 flex-col gap-2">
              <TrendWord trend={slice.trend} />
              <div
                className="flex w-fit items-end gap-1"
                role="group"
                aria-label="Recent runs"
              >
                {points.map((point) => (
                  <RunBar
                    key={point.runId}
                    point={point}
                    onClick={() => openRun(point)}
                  />
                ))}
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Run it once to start a trend.
            </p>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 md:flex-col md:items-end">
          {latest ? (
            <span className="flex flex-col gap-0.5 text-xs text-muted-foreground md:items-end">
              <span>
                <button
                  type="button"
                  className="font-medium text-foreground hover:underline"
                  onClick={() => openRun(latest)}
                >
                  Run #{latest.runNumber}
                </button>
                {" · "}
                <span
                  className={cn(
                    "font-semibold",
                    latest.passed ? "text-success" : "text-destructive",
                  )}
                >
                  {latest.passed ? "Passed" : "Failed"} {latest.rate}%
                </span>
              </span>
              <span>
                {formatDistanceToNow(latest.completedAt, { addSuffix: true })}
              </span>
            </span>
          ) : (
            <span />
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2.5"
            onClick={() => onOpenSettings(suite._id)}
          >
            <Settings2 className="size-3.5" aria-hidden />
            Suite settings
          </Button>
        </div>
      </div>
    </li>
  );
}

function TrendWord({ trend }: { trend: SuiteTrend }) {
  switch (trend.kind) {
    case "single":
      return <p className="text-xs text-muted-foreground">One run so far</p>;
    case "flaky":
      return (
        <p className="text-xs">
          <span className="font-medium text-warning">Flaky</span>{" "}
          <span className="text-muted-foreground">
            · passed {trend.passed} of {trend.runs}
          </span>
        </p>
      );
    case "steady":
      return (
        <p className="text-xs">
          <span className="font-medium">Steady</span>{" "}
          <span className="text-muted-foreground">over {trend.runs} runs</span>
        </p>
      );
    case "up":
    case "down":
      return (
        <p className="text-xs">
          <span
            className={cn(
              "font-medium",
              trend.kind === "up" ? "text-success" : "text-destructive",
            )}
          >
            {trend.kind === "up" ? "↑ Up" : "↓ Down"} {trend.points} pts
          </span>{" "}
          <span className="text-muted-foreground">over {trend.runs} runs</span>
        </p>
      );
  }
}

function RunBar({
  point,
  onClick,
}: {
  point: SuiteSlicePoint;
  onClick: () => void;
}) {
  const verdict = point.passed ? "passed" : "failed";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Run #${point.runNumber}, ${verdict}, ${point.rate}%`}
      title={`Run #${point.runNumber} · ${point.passed ? "Passed" : "Failed"} · ${point.rate}%`}
      className="flex w-9 flex-col items-center gap-1 rounded-md hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        aria-hidden
        className="flex h-8 w-full items-end overflow-hidden rounded-sm bg-muted"
      >
        <span
          className={cn(
            "w-full rounded-sm",
            point.passed ? "bg-success" : "bg-destructive",
          )}
          style={{ height: `${Math.max(point.rate, 4)}%` }}
        />
      </span>
      <span className="text-[10px] tabular-nums text-muted-foreground">
        #{point.runNumber}
      </span>
    </button>
  );
}
