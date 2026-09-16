import { useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { runClientIdentity } from "../evals/helpers";
import {
  groupProjectRuns,
  projectRunRollup,
} from "../evals/project-run-suite-groups";
import type { ProjectRunRow } from "../evals/project-runs-table";
import type { ProjectRunHistoryDetail } from "../evals/use-project-run-history";
import type { EvalSuiteOverviewEntry } from "../evals/types";

export function buildSuiteHealth(
  rows: ProjectRunRow[],
  details: Map<string, ProjectRunHistoryDetail>,
  suiteId: string,
  clientKey: string,
) {
  const suiteRows = rows.filter((row) => row.suiteId === suiteId);
  const launches = groupProjectRuns(suiteRows, details)[0]?.launches ?? [];
  const points = launches
    .flatMap((launch) => {
      const members = launch.runs.filter((row) => {
        const run = details.get(row._id)?.run;
        return run && runClientIdentity(run).key === clientKey;
      });
      if (
        !members.length ||
        members.some((row) =>
          ["pending", "running", "grading"].includes(row.status),
        )
      )
        return [];
      const stats = projectRunRollup(members, details);
      if (!stats || stats.total === 0) return [];
      // Match the table row's launch target, even when the chart measures
      // only one client within that launch.
      const representative = [...launch.runs].sort(
        (a, b) => a.runNumber - b.runNumber || a._id.localeCompare(b._id),
      )[0];
      const run = details.get(members[0]._id)!.run;
      return [
        {
          key: launch.key,
          runNumber: representative.runNumber,
          target:
            representative.suiteName !== null
              ? { suiteId: representative.suiteId, runId: representative._id }
              : null,
          date: Math.max(...members.map((row) => row.createdAt)),
          rate: (100 * stats.passed) / stats.total,
          threshold: run.passCriteria?.minimumPassRate ?? null,
        },
      ];
    })
    .sort((a, b) => a.date - b.date || a.runNumber - b.runNumber);
  return {
    points,
    average: points.length
      ? points.reduce((sum, point) => sum + point.rate, 0) / points.length
      : null,
    threshold: points.at(-1)?.threshold ?? null,
  };
}

/**
 * Runs charted at once. The page reads a bounded slice of history, and a bar
 * plus a date label per run is a DOM node per run — both are why this is the
 * most recent window rather than everything loaded.
 */
const MAX_HEALTH_POINTS = 60;

export function SuiteHealth({
  rows,
  details,
  complete,
  partial = false,
  failed,
  onRetry,
  hostNamesById,
  suiteOverview,
  onHoverRun,
  onSelectRun,
}: {
  rows: ProjectRunRow[];
  details: Map<string, ProjectRunHistoryDetail>;
  /** Enough has loaded to draw something. */
  complete: boolean;
  /** More runs exist than the chart has read. */
  partial?: boolean;
  failed: boolean;
  onRetry: () => void;
  hostNamesById: ReadonlyMap<string, string | null>;
  suiteOverview?: EvalSuiteOverviewEntry[];
  onHoverRun?: (key: string | null) => void;
  onSelectRun?: (target: { suiteId: string; runId: string }) => void;
}) {
  const [selectedSuite, setSelectedSuite] = useState<string>();
  const [selectedClient, setSelectedClient] = useState<string>();
  const ordered = [...rows].sort(
    (a, b) => b.createdAt - a.createdAt || b.runNumber - a.runNumber,
  );
  const suites = [
    ...new Map(
      ordered.map((row) => [row.suiteId, row.suiteName ?? "Untitled suite"]),
    ).entries(),
  ];
  const suiteId = suites.some(([id]) => id === selectedSuite)
    ? selectedSuite!
    : (suites[0]?.[0] ?? "");
  const clients = new Map<string, string>();
  for (const row of ordered.filter((row) => row.suiteId === suiteId)) {
    const run = details.get(row._id)?.run;
    if (!run) continue;
    const client = runClientIdentity(run, hostNamesById);
    if (!clients.has(client.key)) clients.set(client.key, client.name);
  }
  const clientKey =
    selectedClient && clients.has(selectedClient)
      ? selectedClient
      : (clients.keys().next().value ?? "");
  const {
    points: allPoints,
    average,
    threshold: recordedThreshold,
  } = buildSuiteHealth(rows, details, suiteId, clientKey);
  const points = allPoints.slice(-MAX_HEALTH_POINTS);
  const threshold =
    suiteOverview?.find((entry) => entry.suite._id === suiteId)?.suite
      .defaultPassCriteria?.minimumPassRate ?? recordedThreshold;
  const validThreshold =
    threshold != null &&
    Number.isFinite(threshold) &&
    threshold >= 0 &&
    threshold <= 100;
  const dateLabel = (date: number) =>
    Number.isFinite(date)
      ? new Date(date).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        })
      : "Unknown date";

  return (
    <section aria-label="Suite Health" className="mb-8 space-y-3">
      <h2 className="text-base font-semibold">Suite Health</h2>
      <div className="space-y-4 rounded-xl border border-border bg-background p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-semibold">
            {suites.find(([id]) => id === suiteId)?.[1] ?? "No runs yet"}
          </h3>
          <div className="flex flex-wrap gap-2">
            <Select
              value={clientKey}
              onValueChange={setSelectedClient}
              disabled={!clients.size}
            >
              <SelectTrigger size="sm" aria-label="Suite Health client">
                <SelectValue placeholder="Client" />
              </SelectTrigger>
              <SelectContent>
                {[...clients].map(([key, label]) => (
                  <SelectItem key={key} value={key}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={suiteId}
              onValueChange={(value) => {
                setSelectedSuite(value);
                setSelectedClient(undefined);
              }}
              disabled={!suites.length}
            >
              <SelectTrigger size="sm" aria-label="Suite Health suite">
                <SelectValue placeholder="Suite" />
              </SelectTrigger>
              <SelectContent>
                {suites.map(([id, label]) => (
                  <SelectItem key={id} value={id}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {!complete ? (
          failed ? (
            <div className="py-8 text-sm text-muted-foreground" role="status">
              Could not load run history.{" "}
              <Button variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
            </div>
          ) : (
            <SuiteHealthSkeleton />
          )
        ) : average == null ? (
          <p className="py-8 text-sm text-muted-foreground">
            No completed runs with recorded results for this client.
          </p>
        ) : (
          <>
            <div className="flex items-baseline gap-3">
              <span
                className="text-[40px] font-semibold leading-[44px] tracking-tight"
                data-testid="suite-health-average"
              >
                {Math.round(average)}%
              </span>
              <span className="text-[13px] text-muted-foreground">
                {/* Says what it counted. The average is over every run read;
                    the chart below shows the most recent window of them. */}
                average across {allPoints.length}{" "}
                {allPoints.length === 1 ? "run" : "runs"}
                {partial ? " read so far" : ""}
              </span>
            </div>
            {allPoints.length > points.length && (
              <p className="text-xs text-muted-foreground">
                Charting the most recent {points.length} of {allPoints.length}{" "}
                runs.
              </p>
            )}
            {failed && (
              <p className="text-xs text-muted-foreground">
                Some runs could not be read.{" "}
                <Button variant="outline" size="sm" onClick={onRetry}>
                  Retry
                </Button>
              </p>
            )}
            <div className="flex gap-2 pt-2">
              <div className="relative mt-2 h-20 w-9 shrink-0 text-right text-[11px] text-muted-foreground">
                <span className="absolute right-0 top-0 -translate-y-1/2">
                  100%
                </span>
                <span className="absolute bottom-0 right-0 translate-y-1/2">
                  0%
                </span>
                {validThreshold && (
                  <span
                    className="absolute right-0 translate-y-1/2 bg-background font-semibold text-ring"
                    style={{ bottom: `${threshold}%` }}
                  >
                    {threshold}%
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1 overflow-x-auto pt-2">
                <div style={{ minWidth: points.length * 80 }}>
                  <div
                    className="relative flex h-20 items-end gap-1.5"
                    role="group"
                    aria-label="Pass rate per run"
                  >
                    {points.map((point) => (
                      <button
                        key={point.key}
                        type="button"
                        disabled={!point.target || !onSelectRun}
                        onMouseEnter={() => onHoverRun?.(point.key)}
                        onMouseLeave={() => onHoverRun?.(null)}
                        onFocus={() => onHoverRun?.(point.key)}
                        onBlur={() => onHoverRun?.(null)}
                        onClick={() =>
                          point.target && onSelectRun?.(point.target)
                        }
                        aria-label={`Run #${point.runNumber}, ${dateLabel(point.date)}: ${Math.round(point.rate)}%`}
                        title={`Run #${point.runNumber} · ${dateLabel(point.date)} · ${Math.round(point.rate)}%`}
                        data-testid="suite-health-bar"
                        className="min-w-2 flex-1 cursor-pointer rounded-sm border-0 bg-primary p-0 hover:opacity-80 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
                        style={{
                          height: `${point.rate}%`,
                          minHeight: point.rate === 0 ? 1 : undefined,
                        }}
                      />
                    ))}
                    {validThreshold && (
                      <div
                        data-testid="suite-health-threshold"
                        aria-label={`Minimum accuracy: ${threshold}%`}
                        className="pointer-events-none absolute inset-x-0 border-t-2 border-dashed border-ring"
                        style={{ bottom: `${threshold}%` }}
                      />
                    )}
                  </div>
                  <div className="mt-2 flex gap-1.5 text-[11px] text-muted-foreground">
                    {points.map((point) => (
                      <span
                        key={point.key}
                        data-testid="suite-health-bar-date"
                        className="min-w-2 flex-1 whitespace-nowrap text-center"
                      >
                        {dateLabel(point.date)}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            {!validThreshold && (
              <p className="text-xs text-muted-foreground">
                No minimum accuracy recorded.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * The loaded card's own shape, at its own height: the average, the axis, and
 * three bars. A one-line "Loading…" collapsed the card to nothing and then
 * shoved the whole page down when the runs arrived.
 */
function SuiteHealthSkeleton() {
  return (
    <div role="status" aria-label="Loading run history">
      <div className="flex items-baseline gap-3">
        <Skeleton className="h-[34px] w-[74px]" />
        <Skeleton className="h-3 w-32" />
      </div>
      <div className="flex gap-2 pt-2">
        <div className="relative mt-2 h-20 w-9 shrink-0 text-right text-[11px] text-muted-foreground">
          <span className="absolute right-0 top-0 -translate-y-1/2">100%</span>
          <span className="absolute bottom-0 right-0 translate-y-1/2">0%</span>
        </div>
        <div className="min-w-0 flex-1 pt-2">
          <div className="flex h-20 items-end gap-1.5">
            {[62, 84, 48].map((height) => (
              <Skeleton
                key={height}
                className="min-w-2 flex-1 rounded-sm rounded-b-none"
                style={{ height: `${height}%` }}
              />
            ))}
          </div>
          <div className="mt-2 flex gap-1.5">
            {[0, 1, 2].map((index) => (
              <div key={index} className="flex min-w-2 flex-1 justify-center">
                <Skeleton className="h-3 w-10" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
