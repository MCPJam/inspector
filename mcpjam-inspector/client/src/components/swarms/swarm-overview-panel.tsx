/**
 * Swarms Overview — the default landing view.
 *
 * Three outcome metric cards, then the project's recent runs GROUPED BY
 * JOURNEY, and under each journey's latest run the "findings": the rubric
 * criteria that are failing, with a fail count over the graded denominator and
 * a cross-run streak. Clicking a finding expands the sessions it failed on;
 * clicking one of those opens it in the Sessions browser.
 *
 * Two honesty rules run through the whole panel:
 *
 *   - Denominators are the GRADED counts, never the session totals. Rubric
 *     grading is asynchronous, so "4 of 15" while eleven verdicts are still in
 *     flight would overstate the sample and understate the failure.
 *   - Absent is unknown. A missing `criterionSummary`, a missing
 *     `goalScoreSummary`, a zero graded count — each renders as "—" or as
 *     nothing at all, never as 0%.
 *
 * Undefined-safety is load-bearing rather than polish: this is the DEFAULT tab
 * and its query is string-keyed, so it renders against `undefined` from both
 * queries whenever the backend hasn't deployed `getSwarmOverview` yet (and in
 * every SwarmsTab test that mocks convex/react to `undefined`). The
 * ErrorBoundary below catches a THROWING query; it cannot catch
 * `undefined.runs`, so the shells are explicit.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, usePaginatedQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { evalSurfaceCardClass } from "@/components/evals/eval-surface-chrome";
import {
  LatencyTrendMetric,
  TrendMetric,
} from "@/components/evals/metric-strip";
import { EvalSparkline } from "@/components/evals/eval-sparkline";
import {
  MIN_TREND_POINTS,
  formatCompactNumber,
} from "@/components/evals/metric-strip-data";
import { SwarmsEmptyHero } from "@/components/swarms/swarms-empty-hero";
import {
  formatJourneyRelativeTime,
  runStatusChipClass,
} from "@/components/swarms/journey-run-format";
import {
  DEFAULT_PAGE_SIZE,
  SWARM_QUERIES,
  type JourneySessionRow,
  type SwarmOverview,
  type SwarmOverviewFinding,
  type SwarmOverviewRun,
  type SwarmSessionMetrics,
} from "@/lib/swarm-api";
import {
  PREDICATE_KIND_LABELS,
  type PredicateKind,
} from "@/shared/predicate-kinds";
import { shouldQueryProjectId } from "@/hooks/useProjects";

/** Short day label for sparkline points, e.g. "Jul 3". */
function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** One decimal below 10%, whole percent above. `rate` is a 0..1 fraction. */
function formatPercent(rate: number): string {
  const pct = rate * 100;
  return `${pct >= 10 || pct === 0 ? Math.round(pct) : pct.toFixed(1)}%`;
}

/**
 * Author label, else the predicate kind's label, else the raw criterion id.
 *
 * The raw-id fallback is deliberate — a finding whose criterion no longer
 * appears in the run snapshot still has real counts, and inventing a friendly
 * name for it would be a guess.
 */
function findingName(finding: SwarmOverviewFinding): string {
  const label = finding.label?.trim();
  if (label) return label;
  if (finding.kind && finding.kind in PREDICATE_KIND_LABELS) {
    return PREDICATE_KIND_LABELS[finding.kind as PredicateKind];
  }
  return finding.criterionId;
}

/**
 * Severity is DERIVED, not stored: `blocking` once at least half the graded
 * sessions failed the criterion, `degraded` otherwise.
 *
 * Never derived from a zero denominator. `failCount > 0` with
 * `sessionsGraded === 0` is a contradiction the backend cannot produce, but
 * `0 >= 0/2` is true, so an unguarded comparison would flag an empty run as
 * blocking on the one shape where we know nothing at all.
 */
function findingSeverity(
  finding: SwarmOverviewFinding
): "blocking" | "degraded" {
  if (finding.sessionsGraded <= 0) return "degraded";
  return finding.failCount >= finding.sessionsGraded / 2
    ? "blocking"
    : "degraded";
}

/** "4 of 15 sessions · 2 runs" — the graded denominator, plus the streak. */
function findingCountLabel(finding: SwarmOverviewFinding): string {
  const base = `${finding.failCount} of ${finding.sessionsGraded} session${
    finding.sessionsGraded === 1 ? "" : "s"
  }`;
  if (finding.runStreak <= 1) return base;
  return `${base} · ${finding.runStreak} runs`;
}

/** Run score = judge pass rate. `null` whenever nothing was graded. */
function runScoreRate(run: SwarmOverviewRun): number | null {
  const summary = run.goalScoreSummary;
  if (!summary || summary.gradedCount <= 0) return null;
  return summary.passedCount / summary.gradedCount;
}

type JourneyGroup = {
  journeyRefId: string;
  journeyName: string;
  journeyArchived: boolean;
  personaName: string;
  /** Newest-first. The FIRST entry is the journey's latest run. */
  runs: SwarmOverviewRun[];
};

/**
 * Group runs by journey, preserving the backend's newest-first order both
 * across groups (a journey ranks by its most recent run) and within them.
 */
function groupRunsByJourney(runs: readonly SwarmOverviewRun[]): JourneyGroup[] {
  const groups = new Map<string, JourneyGroup>();
  for (const run of runs) {
    const existing = groups.get(run.journeyRefId);
    if (existing) {
      existing.runs.push(run);
      continue;
    }
    groups.set(run.journeyRefId, {
      journeyRefId: run.journeyRefId,
      journeyName: run.journeyName,
      journeyArchived: run.journeyArchived,
      personaName: run.personaName,
      runs: [run],
    });
  }
  return [...groups.values()];
}

export interface SwarmOverviewPanelProps {
  /** `null` while signed out — both queries skip rather than firing unscoped. */
  projectId: string | null;
  /**
   * Whether the project has any personas — drives which empty state shows.
   * `undefined` while the persona list is still loading: without that third
   * state the panel flashes the create-your-first-persona hero at every
   * existing user on every mount.
   */
  hasPersonas: boolean | undefined;
  onCreatePersona: () => void;
  /** Open a session in the Sessions browser (the parent owns the tab flip). */
  onOpenSession: (sessionId: string) => void;
  /**
   * The SHARED per-journey launch coordinator from SwarmsTab — idempotency
   * keys and in-flight dedupe come with it, so a Run again click here and a
   * Run click on the Personas tab collapse into one paid run.
   */
  onLaunchJourney: (
    journeyRefId: string
  ) => Promise<
    { status: "launched"; runId?: string } | { status: "already_launching" }
  >;
}

export function SwarmOverviewPanel(props: SwarmOverviewPanelProps) {
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="swarms-overview-panel"
    >
      {/* An undeployed backend query THROWS from useQuery. The fallback is the
          empty state rather than `null`, because a blank default tab is what a
          user would be staring at pre-backend-deploy. */}
      <ErrorBoundary
        fallback={
          props.hasPersonas === false ? (
            <SwarmsEmptyHero onCreatePersona={props.onCreatePersona} />
          ) : (
            <NoRunsEmptyState />
          )
        }
      >
        <SwarmOverviewPanelBody {...props} />
      </ErrorBoundary>
    </div>
  );
}

function SwarmOverviewPanelBody({
  projectId,
  hasPersonas,
  onCreatePersona,
  onOpenSession,
  onLaunchJourney,
}: SwarmOverviewPanelProps) {
  // `shouldQueryProjectId`, not a bare truthiness check: a local/placeholder or
  // UUID project id mid-transition would 500 the Convex arg validator, and the
  // panel would surface that as an ErrorBoundary fallback rather than staying
  // unloaded. Same guard the sibling project-scoped swarm reads use.
  const queryable = shouldQueryProjectId(projectId);
  const overview = useQuery(
    SWARM_QUERIES.getSwarmOverview as any,
    (queryable ? { projectId } : "skip") as any
  ) as SwarmOverview | undefined;

  const metrics = useQuery(
    SWARM_QUERIES.getSwarmSessionMetrics as any,
    (queryable ? { projectId } : "skip") as any
  ) as SwarmSessionMetrics | undefined;

  const groups = useMemo(
    () => groupRunsByJourney(overview?.runs ?? []),
    [overview]
  );

  // Confirmed-empty personas ⇒ the create-persona hero, verbatim. Checked
  // before the overview shell: an account with nothing in it should never see
  // a spinner for data that will come back empty.
  if (hasPersonas === false) {
    return <SwarmsEmptyHero onCreatePersona={onCreatePersona} />;
  }

  if (hasPersonas === undefined || overview === undefined) {
    return <LoadingShell />;
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-4 px-6 py-5">
        <OverviewMetricCards overview={overview} metrics={metrics} />
        {groups.length === 0 ? (
          <NoRunsEmptyState />
        ) : (
          <div className="flex flex-col gap-3">
            {groups.map((group) => (
              <JourneyGroupCard
                key={group.journeyRefId}
                group={group}
                onOpenSession={onOpenSession}
                onLaunchJourney={onLaunchJourney}
              />
            ))}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

// ── metric cards ────────────────────────────────────────────────────────────

function OverviewMetricCards({
  overview,
  metrics,
}: {
  overview: SwarmOverview;
  metrics: SwarmSessionMetrics | undefined;
}) {
  const { goalCompletion } = overview;

  const goalPointLabels = useMemo(
    () => goalCompletion.trend.map((p) => formatDay(p.dayStartMs)),
    [goalCompletion]
  );
  const goalSeries = useMemo(
    () => goalCompletion.trend.map((p) => p.passRate * 100),
    [goalCompletion]
  );
  const sessionPointLabels = useMemo(
    () => (metrics?.trend ?? []).map((p) => formatDay(p.dayStartMs)),
    [metrics]
  );
  const sessionSeries = useMemo(() => {
    const trend = metrics?.trend ?? [];
    return {
      tokens: trend.map((p) => p.avgTokensPerSession ?? 0),
      latencyP50: trend.map((p) => p.latencyP50Ms ?? 0),
      latencyP95: trend.map((p) => p.latencyP95Ms ?? 0),
    };
  }, [metrics]);

  const showGoalTrend = goalCompletion.trend.length >= MIN_TREND_POINTS;
  const showSessionTrend = (metrics?.trend?.length ?? 0) >= MIN_TREND_POINTS;

  // State the SAMPLE, not just the number. The goal-completion judge does not
  // auto-run by default, so "0 graded" is the ordinary case and the sub is
  // what tells a reader the headline "—" means unmeasured, not failing.
  const goalSub =
    goalCompletion.gradedCount > 0
      ? `${goalCompletion.gradedCount} graded session${
          goalCompletion.gradedCount === 1 ? "" : "s"
        } across ${goalCompletion.runsWithGrades} run${
          goalCompletion.runsWithGrades === 1 ? "" : "s"
        }`
      : "no sessions graded yet";

  return (
    <div
      className={cn(
        evalSurfaceCardClass,
        "grid grid-cols-1 overflow-hidden sm:grid-cols-3"
      )}
      data-testid="swarm-overview-metric-cards"
    >
      <TrendMetric
        divider={false}
        label="Goal completion"
        value={
          goalCompletion.passRate != null
            ? formatPercent(goalCompletion.passRate)
            : "—"
        }
        sub={goalSub}
        chart={
          showGoalTrend ? (
            <EvalSparkline
              points={goalSeries}
              pointLabels={goalPointLabels}
              formatValue={(v) => `${v.toFixed(0)}%`}
              testId="swarm-overview-sparkline-goal"
            />
          ) : undefined
        }
      />
      <TrendMetric
        label="Tokens per session"
        value={
          metrics?.avgTokensPerSession != null
            ? formatCompactNumber(metrics.avgTokensPerSession)
            : "—"
        }
        sub={
          metrics && metrics.tokenSampleCount > 0
            ? `${metrics.tokenSampleCount} of ${metrics.sessionCount} sessions`
            : "per session"
        }
        chart={
          showSessionTrend && (metrics?.tokenSampleCount ?? 0) > 0 ? (
            <EvalSparkline
              points={sessionSeries.tokens}
              pointLabels={sessionPointLabels}
              formatValue={formatCompactNumber}
              testId="swarm-overview-sparkline-tokens"
            />
          ) : undefined
        }
      />
      {/* Session latency, NOT tool-call latency: the data model carries only
          per-session summed host-turn latency (`readiness.hostLatencyMs`).
          Labelling this "Tool call P50" would misname what it measures. */}
      <LatencyTrendMetric
        p50={metrics?.latencyP50Ms ?? null}
        p95={metrics?.latencyP95Ms ?? null}
        p50Series={sessionSeries.latencyP50}
        p95Series={sessionSeries.latencyP95}
        pointLabels={sessionPointLabels}
        showTrend={showSessionTrend}
        subLabel="per session"
      />
    </div>
  );
}

// ── journey group ───────────────────────────────────────────────────────────

function JourneyGroupCard({
  group,
  onOpenSession,
  onLaunchJourney,
}: {
  group: JourneyGroup;
  onOpenSession: (sessionId: string) => void;
  onLaunchJourney: SwarmOverviewPanelProps["onLaunchJourney"];
}) {
  const [launching, setLaunching] = useState(false);
  const latest = group.runs[0];

  const onRunAgain = async () => {
    if (launching || group.journeyArchived) return;
    setLaunching(true);
    try {
      const result = await onLaunchJourney(group.journeyRefId);
      if (result.status === "already_launching") return;
      toast.success("Journey run started");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start run");
    } finally {
      setLaunching(false);
    }
  };

  return (
    <section
      className="rounded-lg border border-border/60"
      data-testid="swarm-overview-journey"
      data-journey-id={group.journeyRefId}
    >
      <header className="flex items-start justify-between gap-3 border-b border-border/40 px-4 py-3">
        <div className="min-w-0">
          <h3
            className="truncate text-sm font-semibold"
            title={group.journeyName}
          >
            {group.journeyName}
          </h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {group.personaName}
            {group.journeyArchived ? " · archived" : ""}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 shrink-0 px-2.5 text-xs"
          disabled={launching || group.journeyArchived}
          title={
            group.journeyArchived
              ? "This journey is archived — restore it to run again."
              : undefined
          }
          onClick={() => void onRunAgain()}
        >
          {launching ? "Starting…" : "Run again"}
        </Button>
      </header>

      <ul className="divide-y divide-border/40">
        {group.runs.map((run) => (
          <RunRow key={run.runId} run={run} />
        ))}
      </ul>

      {latest.findings.length > 0 ? (
        <div
          className="border-t border-border/40 px-4 py-3"
          data-testid="swarm-overview-findings"
        >
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Findings · latest run
          </p>
          <div className="flex flex-col gap-1.5">
            {latest.findings.map((finding) => (
              <FindingRow
                key={finding.criterionId}
                finding={finding}
                runId={latest.runId}
                onOpenSession={onOpenSession}
              />
            ))}
          </div>
          <p className="mt-2.5 text-[11px] text-muted-foreground">
            Run again launches this journey with its current configuration.
          </p>
        </div>
      ) : null}
    </section>
  );
}

function RunRow({ run }: { run: SwarmOverviewRun }) {
  const rate = runScoreRate(run);
  return (
    <li
      className="flex items-center justify-between gap-3 px-4 py-2"
      data-testid="swarm-overview-run"
      data-run-id={run.runId}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
            runStatusChipClass(run.status)
          )}
        >
          {run.status.replace(/_/g, " ")}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {formatJourneyRelativeTime(run.createdAt)} · {run.summary.succeeded}/
          {run.summary.total} sessions
        </span>
      </div>
      {/* "—" rather than 0%: an ungraded run is unmeasured, not failing. */}
      <span className="shrink-0 text-xs font-semibold tabular-nums">
        {rate != null ? formatPercent(rate) : "—"}
      </span>
    </li>
  );
}

// ── findings ────────────────────────────────────────────────────────────────

function FindingRow({
  finding,
  runId,
  onOpenSession,
}: {
  finding: SwarmOverviewFinding;
  runId: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const severity = findingSeverity(finding);

  return (
    <div className="rounded-md border border-border/50">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        data-testid="swarm-overview-finding"
        data-criterion-id={finding.criterionId}
      >
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            severity === "blocking"
              ? "bg-red-500/10 text-red-700 dark:text-red-400"
              : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
          )}
        >
          {severity}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {findingName(finding)}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {findingCountLabel(finding)}
          {finding.pendingCount > 0
            ? ` · ${finding.pendingCount} still grading`
            : ""}
        </span>
      </button>
      {expanded ? (
        <FindingSessions
          runId={runId}
          criterionId={finding.criterionId}
          onOpenSession={onOpenSession}
        />
      ) : null}
    </div>
  );
}

/**
 * The sessions a criterion actually failed on.
 *
 * Filtered CLIENT-side from the run's sessions: `criteria.results` exists only
 * on a COMPLETED grade, which is exactly the set we want — a pending or broken
 * grade asserts nothing about this criterion.
 *
 * The run is paginated to EXHAUSTION before the list is presented. A run is
 * bounded at hosts × sessionsPerHost (≤50 rows), so that costs at most a page
 * or two — and the alternative is worse than slow: the headline count is over
 * every graded session in the run, so filtering one page would quietly show
 * "2 sessions" under a finding that says 4, with nothing on screen admitting
 * the list was partial.
 */
function FindingSessions({
  runId,
  criterionId,
  onOpenSession,
}: {
  runId: string;
  criterionId: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const { results, status, loadMore } = usePaginatedQuery(
    SWARM_QUERIES.listSessionsByJourneyRun as any,
    { journeyRunId: runId } as any,
    { initialNumItems: Math.max(DEFAULT_PAGE_SIZE, 25) }
  );

  // Walk to the end of the run. Bounded by the run's own size, and each call
  // moves the status to `LoadingMore`, so this advances once per landed page
  // rather than spinning.
  useEffect(() => {
    if (status === "CanLoadMore") loadMore(DEFAULT_PAGE_SIZE);
  }, [status, loadMore]);

  const rows = (results ?? []) as JourneySessionRow[];
  const failing = useMemo(
    () =>
      rows.filter((row) =>
        (row.criteria?.results ?? []).some(
          (r) => r.criterionId === criterionId && r.passed === false
        )
      ),
    [rows, criterionId]
  );

  // Hold the spinner until the run is fully loaded. Rendering the partial list
  // mid-walk would flash a shorter set of affected sessions than the finding's
  // own count claims — which is the exact discrepancy the walk exists to avoid.
  if (status !== "Exhausted") {
    return (
      <div className="flex items-center gap-2 border-t border-border/40 px-2.5 py-2 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Loading sessions…
      </div>
    );
  }

  return (
    <div className="border-t border-border/40 px-2.5 py-1.5">
      {failing.length === 0 ? (
        <p className="py-1 text-[11px] text-muted-foreground">
          No session in this run carries a failing verdict for this criterion.
        </p>
      ) : (
        <ul className="flex flex-col">
          {failing.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-1 py-1.5 text-left hover:bg-muted/60"
                onClick={() => onOpenSession(row.id)}
                data-testid="swarm-overview-finding-session"
                data-session-id={row.id}
              >
                <span className="shrink-0 text-[11px] font-medium">
                  {row.personaLabel ?? row.visitorDisplayName ?? "Session"}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                  {row.firstMessagePreview ?? ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── shells + empty states ───────────────────────────────────────────────────

function LoadingShell() {
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
      data-testid="swarm-overview-loading"
    >
      <Loader2 className="size-4 animate-spin" />
      Loading overview…
    </div>
  );
}

/**
 * Personas exist but nothing has been run yet. Distinct from the
 * create-persona hero: the next action is launching a journey, which lives on
 * the Personas tab, so the copy points there rather than at a button this
 * panel doesn't own.
 */
function NoRunsEmptyState() {
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center px-6 py-10"
      data-testid="swarm-overview-no-runs"
    >
      <div className="max-w-sm text-center">
        <h3 className="text-sm font-semibold text-foreground">No runs yet</h3>
        <p className="mt-1.5 text-pretty text-xs text-muted-foreground">
          Open Personas and run one of your journeys. Once a run finishes, its
          outcomes and any failing rubric criteria show up here.
        </p>
      </div>
    </div>
  );
}
