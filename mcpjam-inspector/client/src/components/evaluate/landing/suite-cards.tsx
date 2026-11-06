import { useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ArrowUpDown, ChevronDown, Search, Settings2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { cn } from "@/lib/utils";
import type { EvalSuite, EvalSuiteOverviewEntry } from "../../evals/types";
import { RowRunControl } from "../suites-overview";
import { SuitePills } from "./suite-pills";
import {
  SUITE_CARD_SORTS,
  activeLaunchRunIds,
  buildSuiteCardHealth,
  latestRunState,
  searchSuiteCards,
  sortSuiteCards,
  suiteDisplayName,
  type SuiteCardHealth,
  type SuiteCardPoint,
  type SuiteCardSort,
  type SuiteCardTrend,
} from "./suite-card-model";

export interface SuiteCardRow {
  entry: EvalSuiteOverviewEntry;
  models: (string | null)[];
  clients: string[];
}

type RunTarget = { suiteId: string; runId: string };

export interface SuiteCardsProps {
  rows: SuiteCardRow[];
  onOpenSuite: (suiteId: string) => void;
  onOpenRun: (target: RunTarget) => void;
  onOpenSettings: (suiteId: string) => void;
  onRunSuite: (suite: EvalSuite) => void;
  /** Every active run of the latest launch. */
  onCancelRun: (runIds: string[]) => void;
  rerunningSuiteId: string | null;
  cancellingRunId: string | null;
}

const SEARCH_INPUT =
  "h-8 w-full border-border/50 bg-transparent pl-8 text-sm shadow-none";

/** The Suites tab body: search, sort, and one health card per suite. */
export function SuiteCards({ rows, ...actions }: SuiteCardsProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SuiteCardSort>("recent");
  const withHealth = useMemo(
    () =>
      rows.map((row) => ({ ...row, health: buildSuiteCardHealth(row.entry) })),
    [rows],
  );
  const shown = searchSuiteCards(sortSuiteCards(withHealth, sort), query);
  const sortLabel =
    SUITE_CARD_SORTS.find((option) => option.value === sort)?.label ?? "";

  return (
    <div className="flex flex-col gap-3" data-testid="nav-suite-overview">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden
            className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="All suites"
            aria-label="Search suites"
            className={SEARCH_INPUT}
            data-testid="nav-suite-search"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              aria-label={`Sort suites by ${sortLabel}`}
              data-testid="nav-suite-sort"
            >
              <ArrowUpDown className="size-3.5" aria-hidden />
              <span>
                <span className="text-muted-foreground">Sort:</span> {sortLabel}
              </span>
              <ChevronDown
                className="size-3.5 text-muted-foreground"
                aria-hidden
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={sort}
              onValueChange={(value) => {
                const option = SUITE_CARD_SORTS.find((o) => o.value === value);
                if (option) setSort(option.value);
              }}
            >
              {SUITE_CARD_SORTS.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {shown.length ? (
        <ul className="flex flex-col gap-3" aria-label="Suites">
          {shown.map((row) => (
            <SuiteCard key={row.entry.suite._id} row={row} {...actions} />
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
          No suites match “{query.trim()}”.
        </p>
      )}
    </div>
  );
}

function SuiteCard({
  row,
  onOpenSuite,
  onOpenRun,
  onOpenSettings,
  onRunSuite,
  onCancelRun,
  rerunningSuiteId,
  cancellingRunId,
}: Omit<SuiteCardsProps, "rows"> & {
  row: SuiteCardRow & { health: SuiteCardHealth };
}) {
  const { entry, health } = row;
  const suiteId = entry.suite._id;
  const name = suiteDisplayName(entry);
  const latest = entry.latestRun;
  const state = latestRunState(latest);
  const launchIds = activeLaunchRunIds(entry);
  const openRun = (runId: string) => onOpenRun({ suiteId, runId });
  const tone =
    state.kind === "verdict"
      ? state.verdict === "passed"
        ? "text-success"
        : "text-destructive"
      : "text-muted-foreground";
  const dot =
    state.kind === "verdict"
      ? state.verdict === "passed"
        ? "bg-success"
        : "bg-destructive"
      : "bg-muted-foreground";
  const count = health.counted.length;

  return (
    <li
      className="rounded-xl border border-border bg-card transition-colors hover:bg-muted/30"
      data-testid="nav-suite-overview-row"
      data-suite-id={suiteId}
    >
      <div className="grid gap-x-6 gap-y-4 p-4 md:grid-cols-[minmax(0,1.2fr)_minmax(10rem,1fr)_11rem] md:items-center">
        <button
          type="button"
          onClick={() => onOpenSuite(suiteId)}
          className="min-w-0 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
            <span
              aria-hidden="true"
              data-testid="nav-suite-dot"
              className={cn("size-2 shrink-0 rounded-full", dot)}
            />
            <span className="truncate text-sm font-semibold text-foreground">
              {name}
            </span>
            <SuitePills models={row.models} clients={row.clients} />
          </span>
          <span className="mt-3 flex items-baseline gap-2">
            <span className="text-[28px] font-semibold leading-8 tracking-tight tabular-nums text-foreground">
              {health.average == null ? "—" : `${Math.round(health.average)}%`}
            </span>
            <span className="text-xs text-muted-foreground">
              {count === 0
                ? "No runs yet"
                : count === 1
                  ? "average across the last run"
                  : `average across the last ${count} runs`}
            </span>
          </span>
        </button>
        <div className="min-w-0">
          {health.trend ? (
            <div className="flex min-w-0 flex-col gap-2">
              <p className="text-xs">
                <TrendWords trend={health.trend} />
              </p>
              <RunBars points={health.points} onOpenRun={openRun} />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Run it once to start a trend.
            </p>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 md:flex-col md:items-end">
          <span className="flex flex-col gap-0.5 text-xs text-muted-foreground md:items-end">
            {latest && state.kind !== "none" ? (
              <>
                <span>
                  <button
                    type="button"
                    className="font-medium text-foreground hover:underline"
                    onClick={() => openRun(latest._id)}
                  >
                    Run #{latest.runNumber}
                  </button>
                  {" · "}
                  <span className={cn("font-semibold", tone)}>
                    {state.kind === "verdict"
                      ? `${state.verdict === "passed" ? "Passed" : "Failed"} ${state.rate}%`
                      : state.label}
                  </span>
                </span>
                <span>
                  {formatDistanceToNow(latest.completedAt ?? latest.createdAt, {
                    addSuffix: true,
                  })}
                </span>
              </>
            ) : (
              "No runs yet"
            )}
          </span>
          <div
            className="flex shrink-0 items-center"
            role="group"
            aria-label={`Run or set up ${name}`}
          >
            <RowRunControl
              suite={entry.suite}
              latestRun={latest}
              onRerun={onRunSuite}
              onCancelRun={() => onCancelRun(launchIds)}
              rerunningSuiteId={rerunningSuiteId}
              cancellingRunId={cancellingRunId}
              cancelling={
                cancellingRunId !== null && launchIds.includes(cancellingRunId)
              }
              cancelDisabled={cancellingRunId !== null}
              runLabel="Run"
              className="rounded-r-none"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="-ml-px h-7 rounded-l-none px-2"
              title="Suite settings"
              aria-label="Suite settings"
              onClick={() => onOpenSettings(suiteId)}
            >
              <Settings2 className="size-3.5" aria-hidden />
            </Button>
          </div>
        </div>
      </div>
    </li>
  );
}

function TrendWords({ trend }: { trend: SuiteCardTrend }) {
  switch (trend.kind) {
    case "one":
      return <span className="text-muted-foreground">One run so far</span>;
    case "flaky":
      return (
        <>
          <span className="font-medium text-warning">Flaky</span>{" "}
          <span className="text-muted-foreground">
            · passed {trend.passed} of {trend.of}
          </span>
        </>
      );
    case "steady":
      return (
        <>
          <span className="font-medium text-foreground">Steady</span>{" "}
          <span className="text-muted-foreground">over {trend.of} runs</span>
        </>
      );
    default:
      return (
        <>
          <span
            className={cn(
              "font-medium",
              trend.kind === "up" ? "text-success" : "text-destructive",
            )}
          >
            {trend.kind === "up" ? "↑ Up" : "↓ Down"} {trend.points} pts
          </span>{" "}
          <span className="text-muted-foreground">over {trend.of} runs</span>
        </>
      );
  }
}

function dayLabel(date: number): string {
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function RunBars({
  points,
  onOpenRun,
}: {
  points: readonly SuiteCardPoint[];
  onOpenRun: (runId: string) => void;
}) {
  return (
    <div
      className="flex w-fit items-end gap-1"
      role="group"
      aria-label="Recent runs"
    >
      {points.map((point) => {
        const passed = point.verdict === "passed";
        const rate = Math.round(point.rate);
        return (
          <button
            key={point.runId}
            type="button"
            onClick={() => onOpenRun(point.runId)}
            title={`Run #${point.runNumber} · ${passed ? "Passed" : "Failed"} · ${rate}% · ${dayLabel(point.createdAt)}`}
            aria-label={`Run #${point.runNumber}, ${passed ? "passed" : "failed"}, ${rate}%`}
            data-testid="nav-suite-bar"
            className="flex w-9 flex-col items-center gap-1 rounded-md hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className="flex h-8 w-full items-end rounded-sm bg-muted/40"
              aria-hidden="true"
            >
              <span
                className={cn(
                  "w-full rounded-sm",
                  passed ? "bg-success/70" : "bg-destructive/70",
                )}
                style={{ height: `${Math.max(6, rate)}%` }}
              />
            </span>
            <span
              className={cn(
                "inline-flex h-5 w-full items-center justify-center rounded-md text-[11px] font-semibold tabular-nums",
                passed
                  ? "bg-success/15 text-success"
                  : "bg-destructive/10 text-destructive",
              )}
            >
              #{point.runNumber}
            </span>
          </button>
        );
      })}
    </div>
  );
}
