import {
  useContext,
  useMemo,
  useState,
  type ComponentProps,
  type MouseEvent,
} from "react";
import { formatDistanceToNow } from "date-fns";
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  Cpu,
  Loader2,
  Play,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@mcpjam/design-system/select";
import { cn } from "@/lib/utils";
import {
  ModelDisplayNamesContext,
  modelDisplayName,
} from "@/lib/model-display-name";
import { suiteHasRunnableServers } from "../evals/helpers";
import { isActiveRun } from "../evals/run-metrics";
import type { EvalSuite, EvalSuiteOverviewEntry } from "../evals/types";
import { navigatePlaygroundEvalsRoute } from "./create-suite-navigation";
import {
  ConnectedSuitesOverview,
  resolveSuiteLabels,
  useSuiteLabelSources,
  type SuiteLabelSources,
} from "./suites-overview";
import {
  buildSuiteTrend,
  latestRunLabel,
  type SuiteTrend,
  type SuiteTrendWord,
} from "./suite-trend-model";

export type SuiteCardsSort = "last-run" | "name" | "pass-rate";

const SORT_LABELS: Record<SuiteCardsSort, string> = {
  "last-run": "Last run",
  name: "Name",
  "pass-rate": "Lowest pass rate",
};

export interface SuiteCardsProps extends SuiteLabelSources {
  overview: EvalSuiteOverviewEntry[];
  onSelectSuite: (suiteId: string) => void;
  onSelectRun: (target: { suiteId: string; runId: string }) => void;
  onRerun: (suite: EvalSuite) => void;
  onCancelRun: (runId: string) => void;
  onOpenSettings: (suiteId: string) => void;
  rerunningSuiteId?: string | null;
  cancellingRunId?: string | null;
}

/**
 * Takes the list view's props, so Evaluate swaps one for the other behind the
 * flag. Deleting a suite moves to Suite settings; runs and settings open by
 * address.
 */
export function ConnectedSuiteCards({
  projectId,
  overview,
  onSelectSuite,
  onRerun,
  onCancelRun,
  rerunningSuiteId,
  cancellingRunId,
}: ComponentProps<typeof ConnectedSuitesOverview>) {
  return (
    <SuiteCards
      {...useSuiteLabelSources(projectId)}
      overview={overview}
      onSelectSuite={onSelectSuite}
      onRerun={onRerun}
      onCancelRun={onCancelRun}
      rerunningSuiteId={rerunningSuiteId}
      cancellingRunId={cancellingRunId}
      onSelectRun={({ suiteId, runId }) =>
        navigatePlaygroundEvalsRoute({ type: "run-detail", suiteId, runId })
      }
      onOpenSettings={(suiteId) =>
        navigatePlaygroundEvalsRoute({
          type: "suite-settings",
          suiteId,
          tab: "settings",
        })
      }
    />
  );
}

function lastActivityAt({ suite, latestRun }: EvalSuiteOverviewEntry) {
  return (
    latestRun?.completedAt ??
    latestRun?.createdAt ??
    suite.updatedAt ??
    suite._creationTime ??
    0
  );
}

export function sortSuiteCards(
  rows: { entry: EvalSuiteOverviewEntry; trend: SuiteTrend }[],
  sort: SuiteCardsSort,
) {
  const sorted = [...rows];
  if (sort === "name") {
    sorted.sort((a, b) =>
      (a.entry.suite.name ?? "").localeCompare(b.entry.suite.name ?? ""),
    );
  } else if (sort === "pass-rate") {
    // Suites with no measured run go last: there is nothing to fix yet.
    sorted.sort((a, b) => (a.trend.average ?? 101) - (b.trend.average ?? 101));
  } else {
    sorted.sort((a, b) => lastActivityAt(b.entry) - lastActivityAt(a.entry));
  }
  return sorted;
}

/** The Suites tab: one card per suite with its pass rate and recent runs. */
export function SuiteCards({
  overview,
  environments,
  hostNamesById,
  hostModelsById,
  ...actions
}: SuiteCardsProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SuiteCardsSort>("last-run");
  const labels = useMemo(
    () =>
      resolveSuiteLabels(overview, {
        environments,
        hostNamesById,
        hostModelsById,
      }),
    [overview, environments, hostNamesById, hostModelsById],
  );
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = overview
      .filter(({ suite }) =>
        (suite.name || "Untitled suite").toLowerCase().includes(needle),
      )
      .map((entry) => ({ entry, trend: buildSuiteTrend(entry) }));
    return sortSuiteCards(matching, sort);
  }, [overview, query, sort]);

  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      data-testid="evals-suite-cards"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="All suites"
            aria-label="Search suites"
            className="pl-9"
          />
        </div>
        <Select
          value={sort}
          onValueChange={(value) => setSort(value as SuiteCardsSort)}
        >
          <SelectTrigger className="w-auto gap-2" aria-label="Sort suites">
            <ArrowDownUp className="h-4 w-4" aria-hidden />
            <span className="text-muted-foreground">Sort:</span>
            <span>{SORT_LABELS[sort]}</span>
          </SelectTrigger>
          <SelectContent align="end">
            {Object.entries(SORT_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ul className="flex flex-col gap-3">
        {rows.map(({ entry, trend }) => (
          <li key={entry.suite._id}>
            <SuiteCard
              entry={entry}
              trend={trend}
              clients={labels.get(entry.suite._id)?.clients ?? []}
              models={labels.get(entry.suite._id)?.models ?? []}
              {...actions}
            />
          </li>
        ))}
      </ul>
      {rows.length === 0 && query.trim() ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No suite names match “{query.trim()}”.
        </p>
      ) : null}
    </div>
  );
}

function stop(event: MouseEvent) {
  event.stopPropagation();
}

function SuiteCard({
  entry,
  trend,
  clients,
  models,
  onSelectSuite,
  onSelectRun,
  onRerun,
  onCancelRun,
  onOpenSettings,
  rerunningSuiteId = null,
  cancellingRunId = null,
}: Omit<SuiteCardsProps, keyof SuiteLabelSources | "overview"> & {
  entry: EvalSuiteOverviewEntry;
  trend: SuiteTrend;
  clients: string[];
  models: (string | null)[];
}) {
  const { suite, latestRun } = entry;
  const title = suite.name || "Untitled suite";
  const latest = latestRunLabel(latestRun);
  const latestAt = latestRun?.completedAt ?? latestRun?.createdAt ?? null;
  const knownModels = useContext(ModelDisplayNamesContext);
  const pills = [
    ...models
      .filter((model): model is string => Boolean(model))
      .map((model) => ({
        key: `m:${model}`,
        label: modelDisplayName(model, knownModels),
        model: true,
      })),
    ...clients.map((client) => ({
      key: `c:${client}`,
      label: client,
      model: false,
    })),
  ];

  return (
    <article
      className="grid cursor-pointer gap-4 rounded-xl border border-border bg-card px-5 py-4 transition-colors hover:border-border/80 hover:bg-muted/30 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_11rem]"
      data-testid="evals-suite-card"
      data-suite-id={suite._id}
      onClick={() => onSelectSuite(suite._id)}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              latest?.tone === "success"
                ? "bg-success"
                : latest?.tone === "destructive"
                  ? "bg-destructive"
                  : "bg-muted-foreground/50",
            )}
            aria-hidden
          />
          <button
            type="button"
            className="min-w-0 truncate text-left text-base font-semibold text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => {
              stop(event);
              onSelectSuite(suite._id);
            }}
          >
            {title}
          </button>
          {pills.map((pill) => (
            <span
              key={pill.key}
              className="inline-flex max-w-48 items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground"
            >
              {pill.model ? (
                <Cpu className="h-3 w-3 shrink-0" aria-hidden />
              ) : null}
              <span className="truncate">{pill.label}</span>
            </span>
          ))}
        </div>
        <div className="flex items-baseline gap-2">
          <span
            className="text-3xl font-semibold tabular-nums text-foreground"
            data-testid="evals-suite-card-average"
          >
            {trend.average === null ? "—" : `${Math.round(trend.average)}%`}
          </span>
          <span className="text-sm text-muted-foreground">
            {trend.averagedRuns === 0
              ? "No completed runs yet"
              : trend.averagedRuns === 1
                ? "from its only run"
                : `average across the last ${trend.averagedRuns} runs`}
          </span>
        </div>
      </div>
      <SuiteTrendBars
        suiteId={suite._id}
        trend={trend}
        onSelectRun={onSelectRun}
      />
      <div className="flex flex-col items-start gap-1 md:items-end">
        {latest ? (
          <p className="text-sm font-medium text-foreground">
            Run #{latest.runNumber} ·{" "}
            <span
              className={cn(
                latest.tone === "success" && "text-success",
                latest.tone === "destructive" && "text-destructive",
                latest.tone === "muted" && "text-muted-foreground",
              )}
            >
              {latest.verdict}
            </span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Never run</p>
        )}
        {latestAt ? (
          <p className="text-sm text-muted-foreground">
            {formatDistanceToNow(latestAt, { addSuffix: true })}
          </p>
        ) : null}
        <div className="mt-1 inline-flex" onClick={stop}>
          <SuiteRunButton
            suite={suite}
            latestRun={latestRun}
            onRerun={onRerun}
            onCancelRun={onCancelRun}
            rerunningSuiteId={rerunningSuiteId}
            cancellingRunId={cancellingRunId}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-l-none border-l-0 px-2"
            aria-label={`Suite settings for ${title}`}
            title="Suite settings"
            onClick={() => onOpenSettings(suite._id)}
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>
    </article>
  );
}

function SuiteRunButton({
  suite,
  latestRun,
  onRerun,
  onCancelRun,
  rerunningSuiteId,
  cancellingRunId,
}: {
  suite: EvalSuite;
  latestRun: EvalSuiteOverviewEntry["latestRun"];
  onRerun: (suite: EvalSuite) => void;
  onCancelRun: (runId: string) => void;
  rerunningSuiteId: string | null;
  cancellingRunId: string | null;
}) {
  const title = suite.name || "Untitled suite";
  const className = "gap-1.5 rounded-r-none";
  if (latestRun && isActiveRun(latestRun)) {
    const cancelling = cancellingRunId === latestRun._id;
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={className}
        aria-label={`Cancel run for ${title}`}
        disabled={cancelling}
        onClick={() => onCancelRun(latestRun._id)}
      >
        {cancelling ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : null}
        Cancel
      </Button>
    );
  }
  const starting = rerunningSuiteId === suite._id;
  const hasServers = suiteHasRunnableServers(suite);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={className}
      aria-label={`Run ${title}`}
      title={hasServers ? undefined : "Add a server to this suite to run it."}
      disabled={!hasServers || starting}
      onClick={() => onRerun(suite)}
    >
      {starting ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <Play className="h-4 w-4" aria-hidden />
      )}
      Run
    </Button>
  );
}

function TrendWord({ word }: { word: SuiteTrendWord | null }) {
  if (!word)
    return (
      <span className="text-muted-foreground">Not enough runs for a trend</span>
    );
  if (word.kind === "flaky") {
    return (
      <span>
        <span className="font-medium text-warning">Flaky</span>
        <span className="text-muted-foreground">
          {" "}
          · passed {word.passed} of {word.total}
        </span>
      </span>
    );
  }
  if (word.kind === "steady") {
    return (
      <span>
        <span className="font-medium text-foreground">Steady</span>
        <span className="text-muted-foreground"> over {word.runs} runs</span>
      </span>
    );
  }
  const Arrow = word.kind === "up" ? ArrowUp : ArrowDown;
  return (
    <span>
      <span
        className={cn(
          "inline-flex items-center gap-0.5 font-medium",
          word.kind === "up" ? "text-success" : "text-destructive",
        )}
      >
        <Arrow className="h-3.5 w-3.5" aria-hidden />
        {word.kind === "up" ? "Up" : "Down"} {word.points} pts
      </span>
      <span className="text-muted-foreground"> over {word.runs} runs</span>
    </span>
  );
}

function SuiteTrendBars({
  suiteId,
  trend,
  onSelectRun,
}: {
  suiteId: string;
  trend: SuiteTrend;
  onSelectRun: SuiteCardsProps["onSelectRun"];
}) {
  return (
    <div
      className="flex min-w-0 flex-col gap-1.5"
      data-testid="evals-suite-trend"
    >
      <p className="text-sm">
        <TrendWord word={trend.word} />
      </p>
      {trend.bars.length ? (
        <ol className="flex items-end gap-1.5">
          {trend.bars.map((bar) => (
            <li key={bar.runId}>
              <button
                type="button"
                className="group flex w-12 flex-col items-stretch gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Run #${bar.runNumber}: ${bar.passed ? "passed" : "failed"}, ${Math.round(bar.rate)}%`}
                title={`Run #${bar.runNumber} · ${Math.round(bar.rate)}%`}
                onClick={(event) => {
                  stop(event);
                  onSelectRun({ suiteId, runId: bar.runId });
                }}
              >
                <span className="flex h-11 items-end overflow-hidden rounded-md bg-muted/60">
                  <span
                    className={cn(
                      "block w-full rounded-md transition-opacity group-hover:opacity-80",
                      bar.passed ? "bg-success/70" : "bg-destructive/70",
                    )}
                    style={{ height: `${Math.max(bar.rate, 12)}%` }}
                  />
                </span>
                <span
                  className={cn(
                    "rounded-md py-0.5 text-center text-xs font-semibold tabular-nums text-foreground",
                    bar.passed ? "bg-success/15" : "bg-destructive/15",
                  )}
                >
                  #{bar.runNumber}
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
