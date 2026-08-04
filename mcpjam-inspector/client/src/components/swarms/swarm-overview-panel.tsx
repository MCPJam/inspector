/**
 * Swarms Overview — the default landing view.
 *
 * Metric cards stay anchored to the project's latest swarm wave. Below that,
 * a newest-first list of Swarm Runs — each row is a co-launched wave of
 * journey-runs (New swarm fires many at once; a solo "Run again" is a wave of
 * one). Expanding a wave reveals the per-journey view: each journey in that
 * wave with its rubric findings. Clicking a finding expands the sessions it
 * failed on; clicking one of those opens it in the Sessions browser.
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
import { ChevronDown, Loader2 } from "lucide-react";
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
import { formatJourneyRelativeTime } from "@/components/swarms/journey-run-format";
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

/**
 * Journey-runs launched within this gap of each other (newest-first walk) are
 * treated as one Swarm Run. New swarm create fans out with bounded concurrency,
 * so a 10-journey launch can span a few seconds — two minutes covers that
 * without gluing unrelated solo re-runs together.
 */
const SWARM_WAVE_GAP_MS = 2 * 60 * 1000;

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

/** "4 of 15 sessions" — the graded denominator only. */
function findingSessionLabel(finding: SwarmOverviewFinding): string {
  return `${finding.failCount} of ${finding.sessionsGraded} session${
    finding.sessionsGraded === 1 ? "" : "s"
  }`;
}

/** Run score = judge pass rate. `null` whenever nothing was graded. */
function runScoreRate(run: SwarmOverviewRun): number | null {
  const summary = run.goalScoreSummary;
  if (!summary || summary.gradedCount <= 0) return null;
  return summary.passedCount / summary.gradedCount;
}

/** Aggregate pass rate across a wave. `null` when nothing in it was graded. */
function waveScoreRate(runs: readonly SwarmOverviewRun[]): number | null {
  let graded = 0;
  let passed = 0;
  for (const run of runs) {
    const summary = run.goalScoreSummary;
    if (!summary || summary.gradedCount <= 0) continue;
    graded += summary.gradedCount;
    passed += summary.passedCount;
  }
  if (graded <= 0) return null;
  return passed / graded;
}

/** Percentage-point change vs the previous graded wave. */
function scoreChangePoints(
  rate: number | null,
  previousRate: number | null
): number | null {
  if (rate == null || previousRate == null) return null;
  return Math.round((rate - previousRate) * 100);
}

/**
 * Status-dot colour from the wave's worst terminal outcome. Score is shown
 * separately under SCORE — the dot answers "did the swarm finish cleanly?",
 * not "did the judge like it".
 */
function waveStatusDotClass(runs: readonly SwarmOverviewRun[]): string {
  const statuses = new Set(runs.map((r) => r.status));
  if (statuses.has("failed") || statuses.has("stale")) return "bg-red-500";
  if (statuses.has("partial") || statuses.has("rate_limited")) {
    return "bg-amber-500";
  }
  if (statuses.has("running") || statuses.has("pending")) {
    return "bg-muted-foreground/50";
  }
  return "bg-emerald-500";
}

type SwarmWave = {
  /** Anchor id for keys/expansion — the newest journey-run in the wave. */
  waveId: string;
  createdAt: number;
  runs: SwarmOverviewRun[];
};

/**
 * Cluster newest-first journey-runs into Swarm Run waves.
 *
 * There is no durable batch id on `journeyRuns` today — New swarm just fans
 * out N create/launch calls. Runs whose `createdAt` falls within
 * {@link SWARM_WAVE_GAP_MS} of the wave's newest member are the same wave.
 */
export function groupRunsIntoSwarmWaves(
  runs: readonly SwarmOverviewRun[]
): SwarmWave[] {
  const waves: SwarmWave[] = [];
  for (const run of runs) {
    const current = waves[waves.length - 1];
    if (
      current &&
      current.createdAt - run.createdAt <= SWARM_WAVE_GAP_MS
    ) {
      current.runs.push(run);
      continue;
    }
    waves.push({
      waveId: run.runId,
      createdAt: run.createdAt,
      runs: [run],
    });
  }
  return waves;
}

/**
 * Title shaped like the mock: scope after the ·.
 * Solo journey-run keeps the journey name; multi-journey waves collapse to a
 * swarm label so the list reads as runs, not journeys.
 */
function swarmWaveTitle(runs: readonly SwarmOverviewRun[]): string {
  if (runs.length === 1) {
    const only = runs[0]!;
    return `${only.journeyName} · ${only.personaName}`;
  }
  const personas = [...new Set(runs.map((r) => r.personaName))];
  if (personas.length === 1) {
    return `Swarm · ${personas[0]} only`;
  }
  return `Swarm · all personas`;
}

function waveSessionTotals(runs: readonly SwarmOverviewRun[]): {
  succeeded: number;
  total: number;
} {
  let succeeded = 0;
  let total = 0;
  for (const run of runs) {
    succeeded += run.summary.succeeded;
    total += run.summary.total;
  }
  return { succeeded, total };
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
  onNewSwarm: () => void;
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
            <SwarmsEmptyHero onNewSwarm={props.onNewSwarm} />
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
  onNewSwarm,
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

  const waves = useMemo(
    () => groupRunsIntoSwarmWaves(overview?.runs ?? []),
    [overview]
  );

  // Each wave's CHANGE is vs the next older wave that has a graded score.
  const previousScoreByWaveId = useMemo(() => {
    const out = new Map<string, number | null>();
    for (let i = 0; i < waves.length; i++) {
      const wave = waves[i]!;
      let previous: number | null = null;
      for (let j = i + 1; j < waves.length; j++) {
        const olderRate = waveScoreRate(waves[j]!.runs);
        if (olderRate == null) continue;
        previous = olderRate;
        break;
      }
      out.set(wave.waveId, previous);
    }
    return out;
  }, [waves]);

  // Confirmed-empty personas ⇒ the create-swarm hero. Checked before the
  // overview shell: an account with nothing in it should never see a spinner
  // for data that will come back empty.
  if (hasPersonas === false) {
    return <SwarmsEmptyHero onNewSwarm={onNewSwarm} />;
  }

  if (hasPersonas === undefined || overview === undefined) {
    return <LoadingShell />;
  }

  // Default-expand the newest wave that already carries findings so the list
  // isn't a wall of closed rows the first time someone lands here.
  const defaultExpandedWaveId =
    waves.find((wave) => wave.runs.some((run) => run.findings.length > 0))
      ?.waveId ??
    waves[0]?.waveId ??
    null;

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-4 px-6 py-5">
        <OverviewMetricCards
          overview={overview}
          metrics={metrics}
          latestWave={waves[0] ?? null}
        />
        {waves.length === 0 ? (
          <NoRunsEmptyState />
        ) : (
          <SwarmRunsList
            waves={waves}
            previousScoreByWaveId={previousScoreByWaveId}
            defaultExpandedWaveId={defaultExpandedWaveId}
            onOpenSession={onOpenSession}
            onLaunchJourney={onLaunchJourney}
          />
        )}
      </div>
    </ScrollArea>
  );
}

// ── metric cards ────────────────────────────────────────────────────────────

function OverviewMetricCards({
  overview,
  metrics,
  latestWave,
}: {
  overview: SwarmOverview;
  metrics: SwarmSessionMetrics | undefined;
  latestWave: SwarmWave | null;
}) {
  // Metrics stay pinned to the LATEST wave — expanding an older Swarm Run
  // must not retarget these cards. Session tokens/latency still come from the
  // project strip (no wave-scoped metrics query yet).
  const latestPassRate = latestWave ? waveScoreRate(latestWave.runs) : null;
  let latestGraded = 0;
  if (latestWave) {
    for (const run of latestWave.runs) {
      const summary = run.goalScoreSummary;
      if (summary && summary.gradedCount > 0) {
        latestGraded += summary.gradedCount;
      }
    }
  }

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
    latestGraded > 0
      ? `${latestGraded} graded session${
          latestGraded === 1 ? "" : "s"
        } · latest run`
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
        value={latestPassRate != null ? formatPercent(latestPassRate) : "—"}
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

// ── swarm runs list ─────────────────────────────────────────────────────────

function SwarmRunsList({
  waves,
  previousScoreByWaveId,
  defaultExpandedWaveId,
  onOpenSession,
  onLaunchJourney,
}: {
  waves: SwarmWave[];
  previousScoreByWaveId: Map<string, number | null>;
  defaultExpandedWaveId: string | null;
  onOpenSession: (sessionId: string) => void;
  onLaunchJourney: SwarmOverviewPanelProps["onLaunchJourney"];
}) {
  const [expandedWaveId, setExpandedWaveId] = useState<string | null>(
    defaultExpandedWaveId
  );

  return (
    <section data-testid="swarm-overview-runs">
      <header className="mb-2 flex items-end justify-between gap-3 px-0.5">
        <h2 className="text-sm font-semibold text-foreground">Swarm Runs</h2>
        <div className="flex shrink-0 items-center gap-6 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <span className="w-12 text-right">Score</span>
          <span className="w-12 text-right">Change</span>
        </div>
      </header>

      <ul className="flex flex-col gap-2">
        {waves.map((wave) => (
          <SwarmWaveRow
            key={wave.waveId}
            wave={wave}
            previousRate={previousScoreByWaveId.get(wave.waveId) ?? null}
            expanded={expandedWaveId === wave.waveId}
            onToggle={() =>
              setExpandedWaveId((current) =>
                current === wave.waveId ? null : wave.waveId
              )
            }
            onOpenSession={onOpenSession}
            onLaunchJourney={onLaunchJourney}
          />
        ))}
      </ul>
    </section>
  );
}

function SwarmWaveRow({
  wave,
  previousRate,
  expanded,
  onToggle,
  onOpenSession,
  onLaunchJourney,
}: {
  wave: SwarmWave;
  previousRate: number | null;
  expanded: boolean;
  onToggle: () => void;
  onOpenSession: (sessionId: string) => void;
  onLaunchJourney: SwarmOverviewPanelProps["onLaunchJourney"];
}) {
  const rate = waveScoreRate(wave.runs);
  const change = scoreChangePoints(rate, previousRate);
  const title = swarmWaveTitle(wave.runs);
  const sessions = waveSessionTotals(wave.runs);
  const findingCount = wave.runs.reduce(
    (n, run) => n + run.findings.length,
    0
  );
  const personaCount = new Set(wave.runs.map((r) => r.personaName)).size;

  return (
    <li
      className="rounded-lg border border-border/60 bg-background"
      data-testid="swarm-overview-run"
      data-wave-id={wave.waveId}
      data-journey-count={wave.runs.length}
    >
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            waveStatusDotClass(wave.runs)
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-semibold" title={title}>
              {title}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatJourneyRelativeTime(wave.createdAt)}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {sessions.succeeded}/{sessions.total} sessions
            {wave.runs.length > 1
              ? ` · ${wave.runs.length} journeys · ${personaCount} persona${
                  personaCount === 1 ? "" : "s"
                }`
              : ""}
            {findingCount > 0
              ? ` · ${findingCount} finding${findingCount === 1 ? "" : "s"}`
              : ""}
          </p>
        </div>
        <span
          className="w-12 shrink-0 text-right text-sm font-semibold tabular-nums"
          data-testid="swarm-overview-run-score"
        >
          {rate != null ? formatPercent(rate) : "—"}
        </span>
        <span
          className={cn(
            "w-12 shrink-0 text-right text-xs font-semibold tabular-nums",
            change == null
              ? "text-muted-foreground"
              : change > 0
                ? "text-emerald-600 dark:text-emerald-400"
                : change < 0
                  ? "text-red-600 dark:text-red-400"
                  : "text-muted-foreground"
          )}
          data-testid="swarm-overview-run-change"
        >
          {change == null
            ? "—"
            : change > 0
              ? `▲ ${change}`
              : change < 0
                ? `▼ ${Math.abs(change)}`
                : "· 0"}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180"
          )}
        />
      </button>

      {expanded ? (
        <div
          className="border-t border-border/40 px-4 py-3"
          data-testid="swarm-overview-wave-journeys"
        >
          <div className="flex flex-col gap-3">
            {wave.runs.map((run) => (
              <WaveJourneyBlock
                key={run.runId}
                run={run}
                onOpenSession={onOpenSession}
                onLaunchJourney={onLaunchJourney}
              />
            ))}
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * One journey inside an expanded Swarm Run — the per-journey view the list
 * used to show at the top level.
 */
function WaveJourneyBlock({
  run,
  onOpenSession,
  onLaunchJourney,
}: {
  run: SwarmOverviewRun;
  onOpenSession: (sessionId: string) => void;
  onLaunchJourney: SwarmOverviewPanelProps["onLaunchJourney"];
}) {
  const [launching, setLaunching] = useState(false);

  const onRunAgain = async () => {
    if (launching || run.journeyArchived) return;
    setLaunching(true);
    try {
      const result = await onLaunchJourney(run.journeyRefId);
      if (result.status === "already_launching") return;
      toast.success("Journey run started");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start run");
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div
      className="rounded-md border border-border/50"
      data-testid="swarm-overview-journey"
      data-journey-id={run.journeyRefId}
      data-run-id={run.runId}
    >
      <div
        className={cn(
          "flex items-start justify-between gap-3 px-3 py-2.5",
          run.findings.length > 0 && "border-b border-border/40"
        )}
      >
        <div className="min-w-0">
          <p
            className="truncate text-xs font-semibold"
            title={run.journeyName}
          >
            {run.journeyName}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {run.personaName}
            {run.journeyArchived ? " · archived" : ""}
            {" · "}
            {run.summary.succeeded}/{run.summary.total} sessions
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 shrink-0 px-2.5 text-xs"
          disabled={launching || run.journeyArchived}
          title={
            run.journeyArchived
              ? "This journey is archived — restore it to run again."
              : undefined
          }
          onClick={() => void onRunAgain()}
        >
          {launching ? "Starting…" : "Run again"}
        </Button>
      </div>

      {run.findings.length > 0 ? (
        <div className="px-3 py-2.5" data-testid="swarm-overview-findings">
          <div className="flex flex-col gap-2">
            {run.findings.map((finding) => (
              <FindingRow
                key={finding.criterionId}
                finding={finding}
                runId={run.runId}
                onOpenSession={onOpenSession}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
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
    <div
      className={cn(
        "rounded-md border",
        severity === "blocking"
          ? "border-red-500/25 bg-red-500/[0.06]"
          : "border-amber-500/25 bg-amber-500/[0.06]"
      )}
    >
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
            "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white",
            severity === "blocking" ? "bg-red-600" : "bg-amber-500"
          )}
        >
          {severity}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {findingName(finding)}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {findingSessionLabel(finding)}
          {finding.pendingCount > 0
            ? ` · ${finding.pendingCount} still grading`
            : ""}
        </span>
        {finding.runStreak > 1 ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {finding.runStreak} runs
          </span>
        ) : null}
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
