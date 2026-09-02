/**
 * Swarms Overview — the default landing view.
 *
 * A newest-first list of Swarm Runs — each row is a co-launched wave of
 * journey-runs (New swarm fires many at once; a solo "Run again" is a wave of
 * one). Clicking a row opens `/swarms/:swarmId` for the dedicated run detail
 * (findings live on that screen's Insights tab).
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
 * and its query is string-keyed, so it renders against `undefined` whenever the
 * backend hasn't deployed `getSwarmOverview` yet (and in every SwarmsTab test
 * that mocks convex/react to `undefined`). The ErrorBoundary below catches a
 * THROWING query; it cannot catch `undefined.runs`, so the shells are explicit.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, usePaginatedQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@mcpjam/design-system/select";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { cn } from "@/lib/utils";
import { SwarmsEmptyHero } from "@/components/swarms/swarms-empty-hero";
import { JourneyHostLogoMark } from "@/components/swarms/journey-host-logo";
import { formatJourneyRelativeTime } from "@/components/swarms/journey-run-format";
import {
  DEFAULT_PAGE_SIZE,
  SWARM_QUERIES,
  type JourneySessionRow,
  type SwarmOverview,
  type SwarmOverviewFinding,
  type SwarmOverviewRun,
  type SwarmOverviewTarget,
} from "@/lib/swarm-api";
import {
  formatCriterion,
  isKnownPredicateKind,
} from "@/shared/predicate-kinds";
import { EvalSparkline } from "@/components/evals/eval-sparkline";
import { MIN_TREND_POINTS } from "@/components/evals/metric-strip-data";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";

/**
 * Journey-runs launched within this gap of each other (newest-first walk) are
 * treated as one Swarm Run. New swarm create fans out with bounded concurrency,
 * so a 10-journey launch can span a few seconds — two minutes covers that
 * without gluing unrelated solo re-runs together.
 */
const SWARM_WAVE_GAP_MS = 2 * 60 * 1000;

/** One decimal below 10%, whole percent above. `rate` is a 0..1 fraction. */
export function formatPercent(rate: number): string {
  const pct = rate * 100;
  return `${pct >= 10 || pct === 0 ? Math.round(pct) : pct.toFixed(1)}%`;
}

/**
 * Author label, else the predicate kind's label, else the raw criterion id.
 *
 * The label rules are delegated to `formatCriterion` so they stay defined once
 * across the authoring form, the run scorecard, and this panel. The raw-id
 * fallback stays local and is deliberate — a finding whose check no longer
 * appears in the run snapshot still has real counts, and inventing a friendly
 * name for it would be a guess (and `formatCriterion` has no id to fall back
 * to).
 */
export function findingName(finding: SwarmOverviewFinding): string {
  if (finding.kind !== undefined && isKnownPredicateKind(finding.kind)) {
    return formatCriterion({ ...finding, kind: finding.kind });
  }
  return finding.label?.trim() || finding.criterionId;
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
export function findingSeverity(
  finding: SwarmOverviewFinding
): "blocking" | "degraded" {
  if (finding.sessionsGraded <= 0) return "degraded";
  return finding.failCount >= finding.sessionsGraded / 2
    ? "blocking"
    : "degraded";
}

/** "4 of 15 sessions" — the graded denominator only. */
export function findingSessionLabel(finding: SwarmOverviewFinding): string {
  return `${finding.failCount} of ${finding.sessionsGraded} session${
    finding.sessionsGraded === 1 ? "" : "s"
  }`;
}

/** Aggregate pass rate across a wave. `null` when nothing in it was graded. */
export function waveScoreRate(runs: readonly SwarmOverviewRun[]): number | null {
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

/**
 * Status-dot colour from the wave's worst terminal outcome. Score is shown
 * separately under Score — the dot answers "did the swarm finish cleanly?",
 * not "did the judge like it".
 */
export function waveStatusDotClass(runs: readonly SwarmOverviewRun[]): string {
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

export type SwarmWave = {
  /** Anchor id for keys — the newest journey-run in the wave. */
  waveId: string;
  createdAt: number;
  runs: SwarmOverviewRun[];
};

/**
 * URL identity for a wave: durable `swarmRunGroupId` when the launching client
 * stamped one, else the newest journey-run id (`waveId`).
 */
export function swarmWaveRouteId(wave: SwarmWave): string {
  return wave.runs[0]?.swarmRunGroupId ?? wave.waveId;
}

/** Find a wave by route id (`swarmRunGroupId` or any member `runId`). */
export function resolveSwarmWave(
  waves: readonly SwarmWave[],
  swarmId: string
): SwarmWave | null {
  const byRoute = waves.find((w) => swarmWaveRouteId(w) === swarmId);
  if (byRoute) return byRoute;
  return (
    waves.find(
      (w) =>
        w.waveId === swarmId ||
        w.runs.some(
          (r) => r.runId === swarmId || r.swarmRunGroupId === swarmId
        )
    ) ?? null
  );
}

/**
 * Cluster newest-first journey-runs into Swarm Run waves.
 *
 * Runs carrying a `swarmRunGroupId` are grouped by it — a durable identity the
 * launching client stamped, so two people launching at once stay separate and
 * a slow launch (or a partial-failure retry) stays together.
 *
 * Runs WITHOUT one are legacy (or came from a client/backend that predates the
 * field) and keep the original heuristic: within {@link SWARM_WAVE_GAP_MS} of
 * the running wave's newest member. That comparison is deliberately made only
 * against other UNGROUPED runs — letting a grouped run anchor a time window
 * would pull unrelated legacy rows into an explicit wave.
 *
 * Two passes, because grouped runs need not be adjacent in the input: a legacy
 * run can sit between two members of one wave. The first pass buckets; the
 * second re-establishes the ordering invariants the rest of this panel depends
 * on — waves newest-first, each wave's `createdAt` its newest member, and
 * `waveId` that member's runId (used for React keys, `data-wave-id`, and
 * expansion state).
 */
export function groupRunsIntoSwarmWaves(
  runs: readonly SwarmOverviewRun[]
): SwarmWave[] {
  const byGroupId = new Map<string, SwarmOverviewRun[]>();
  const ungroupedWaves: SwarmOverviewRun[][] = [];
  let lastUngroupedAt: number | null = null;

  for (const run of runs) {
    const groupId = run.swarmRunGroupId;
    if (groupId) {
      const bucket = byGroupId.get(groupId);
      if (bucket) bucket.push(run);
      else byGroupId.set(groupId, [run]);
      continue;
    }
    const current = ungroupedWaves[ungroupedWaves.length - 1];
    if (
      current &&
      lastUngroupedAt !== null &&
      lastUngroupedAt - run.createdAt <= SWARM_WAVE_GAP_MS
    ) {
      current.push(run);
      continue;
    }
    ungroupedWaves.push([run]);
    lastUngroupedAt = run.createdAt;
  }

  const waves: SwarmWave[] = [...byGroupId.values(), ...ungroupedWaves].map(
    (members) => {
      // Newest member anchors the wave. The input is already newest-first, so
      // this is members[0] — computed explicitly rather than assumed, since a
      // bucket's order is whatever the input handed it.
      const anchor = members.reduce((newest, run) =>
        run.createdAt > newest.createdAt ? run : newest
      );
      return { waveId: anchor.runId, createdAt: anchor.createdAt, runs: members };
    }
  );

  // Bucket insertion order is first-encounter, which is NOT recency once
  // grouped and ungrouped waves are interleaved. Everything downstream reads
  // `waves[0]` as the latest and treats a higher index as strictly older
  // (the score-delta baseline in particular), so sort before returning.
  return waves.sort((a, b) => b.createdAt - a.createdAt);
}

/** Short id for display — same length convention as evals `formatRunId`. */
export function formatSwarmId(swarmId: string): string {
  return swarmId.substring(0, 8);
}

/**
 * ID-first title, matching evals (`Run n57bwtsk`): `Swarm` + short route id.
 * Scope (goals / personas) lives in the subtitle, not the title.
 */
export function swarmWaveTitle(wave: SwarmWave): string {
  return `Swarm ${formatSwarmId(swarmWaveRouteId(wave))}`;
}

/**
 * Progress of a wave that is STILL GOING, or `null` once every member reached a
 * terminal.
 *
 * `done` counts every terminal attempt — succeeded, failed and rate-limited —
 * because this answers "how far along is the run", which is a different
 * question from {@link waveSessionTotals}' "how much of it worked". A wave whose
 * runs are all terminal returns `null` rather than a full bar: there is no live
 * run to point at, and a 100% progress bar on a finished swarm is noise.
 */
export function waveLiveProgress(runs: readonly SwarmOverviewRun[]): {
  done: number;
  total: number;
  liveRuns: number;
} | null {
  let done = 0;
  let total = 0;
  let liveRuns = 0;
  for (const run of runs) {
    if (run.status === "running" || run.status === "pending") liveRuns += 1;
    done +=
      run.summary.succeeded + run.summary.failed + run.summary.rateLimited;
    total += run.summary.total;
  }
  if (liveRuns === 0) return null;
  return { done, total, liveRuns };
}

export function waveSessionTotals(runs: readonly SwarmOverviewRun[]): {
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

/** Unique pinned targets across a wave (first-seen order). */
export function waveTargets(
  runs: readonly SwarmOverviewRun[]
): SwarmOverviewTarget[] {
  const seen = new Set<string>();
  const out: SwarmOverviewTarget[] = [];
  for (const run of runs) {
    for (const target of run.targets ?? []) {
      const key = `${target.environmentName ?? ""}|${target.hostName}|${target.modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(target);
    }
  }
  return out;
}

/** Collapse unique names into a compact column label. */
function formatNameList(
  names: readonly string[],
  pluralNoun: string
): string {
  if (names.length === 0) return "—";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} +1`;
  return `${names.length} ${pluralNoun}`;
}

/** Unique host display names across a wave (first-seen order). */
export function waveClientNames(
  targets: readonly SwarmOverviewTarget[]
): string[] {
  return [...new Set(targets.map((t) => t.hostName.trim()).filter(Boolean))];
}

/** Client column text fallback / tooltip (environments get their own column). */
export function formatWaveClientLabel(
  targets: readonly SwarmOverviewTarget[]
): string {
  return formatNameList(waveClientNames(targets), "clients");
}

const MAX_CLIENT_LOGOS = 3;

/** Compact host-logo strip for the Client column (HostCompatStrip-style). */
function WaveClientLogoStrip({
  targets,
}: {
  targets: readonly SwarmOverviewTarget[];
}) {
  const names = waveClientNames(targets);
  if (names.length === 0) {
    return (
      <span className="text-xs text-muted-foreground" aria-hidden>
        —
      </span>
    );
  }
  const visible = names.slice(0, MAX_CLIENT_LOGOS);
  const overflow = names.length - visible.length;
  const title = names.join(", ");
  return (
    <span
      className="inline-flex max-w-full items-center justify-end gap-0.5 rounded-full border border-border/70 bg-muted/30 px-1.5 py-0.5"
      title={title}
      aria-label={title}
    >
      {visible.map((name) => (
        <JourneyHostLogoMark key={name} label={name} />
      ))}
      {overflow > 0 ? (
        <span className="pl-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}

/** Unique environment display names across a wave (first-seen order). */
export function waveEnvironmentNames(
  targets: readonly SwarmOverviewTarget[]
): string[] {
  return [
    ...new Set(
      targets
        .map((t) => t.environmentName?.trim())
        .filter((name): name is string => Boolean(name))
    ),
  ];
}

/** Environment column: pinned env names only (flag-gated in the list). */
export function formatWaveEnvironmentLabel(
  targets: readonly SwarmOverviewTarget[]
): string {
  return formatNameList(waveEnvironmentNames(targets), "envs");
}

export type SwarmRunsSort = "newest" | "lowest-score";

/** Filter + sort waves for the Overview list toolbar. */
export function filterAndSortSwarmWaves(
  waves: readonly SwarmWave[],
  opts: {
    clientFilter: string | null;
    envFilter: string | null;
    sort: SwarmRunsSort;
  }
): SwarmWave[] {
  let next = waves.slice();
  if (opts.clientFilter) {
    const needle = opts.clientFilter;
    next = next.filter((wave) =>
      waveClientNames(waveTargets(wave.runs)).includes(needle)
    );
  }
  if (opts.envFilter) {
    const needle = opts.envFilter;
    next = next.filter((wave) =>
      waveEnvironmentNames(waveTargets(wave.runs)).includes(needle)
    );
  }
  if (opts.sort === "lowest-score") {
    next = [...next].sort((a, b) => {
      const aRate = waveScoreRate(a.runs);
      const bRate = waveScoreRate(b.runs);
      // Ungraded waves sink below graded ones; then by ascending score.
      if (aRate == null && bRate == null) return b.createdAt - a.createdAt;
      if (aRate == null) return 1;
      if (bRate == null) return -1;
      if (aRate !== bRate) return aRate - bRate;
      return b.createdAt - a.createdAt;
    });
  }
  // "newest" keeps input order (waves are already newest-first).
  return next;
}

/** Strip provider prefix (`openai/gpt-4o` → `gpt-4o`). */
export function shortModelLabel(modelId: string): string {
  const trimmed = modelId.trim();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

export function formatWaveModelLabel(
  targets: readonly SwarmOverviewTarget[]
): string {
  if (targets.length === 0) return "—";
  const models = [...new Set(targets.map((t) => shortModelLabel(t.modelId)))];
  if (models.length === 1) return models[0]!;
  if (models.length === 2) return `${models[0]} +1`;
  return `${models.length} models`;
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
  /** Navigate to `/swarms/:swarmId` for this wave. */
  onOpenSwarm: (swarmId: string) => void;
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
  onOpenSwarm,
}: SwarmOverviewPanelProps) {
  const environmentsEnabled = useProjectEnvironmentsEnabled();
  // `shouldQueryProjectId`, not a bare truthiness check: a local/placeholder or
  // UUID project id mid-transition would 500 the Convex arg validator, and the
  // panel would surface that as an ErrorBoundary fallback rather than staying
  // unloaded. Same guard the sibling project-scoped swarm reads use.
  const queryable = shouldQueryProjectId(projectId);
  const overview = useQuery(
    SWARM_QUERIES.getSwarmOverview as any,
    (queryable ? { projectId } : "skip") as any
  ) as SwarmOverview | undefined;

  const waves = useMemo(
    () => groupRunsIntoSwarmWaves(overview?.runs ?? []),
    [overview]
  );

  // Confirmed-empty personas ⇒ the create-swarm hero. Checked before the
  // overview shell: an account with nothing in it should never see a spinner
  // for data that will come back empty.
  if (hasPersonas === false) {
    return <SwarmsEmptyHero onNewSwarm={onNewSwarm} />;
  }

  if (hasPersonas === undefined || overview === undefined) {
    return <LoadingShell />;
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-2 px-6 py-3">
        {waves.length === 0 ? (
          <NoRunsEmptyState />
        ) : (
          <>
            <GoalTrendStrip goalCompletion={overview.goalCompletion} />
            <SwarmRunsList
              waves={waves}
              onOpenSwarm={onOpenSwarm}
              environmentsEnabled={environmentsEnabled}
            />
          </>
        )}
      </div>
    </ScrollArea>
  );
}

// ── goal completion trend ───────────────────────────────────────────────────

/** Short day label for trend points, e.g. "Aug 3". */
function formatTrendDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * Goal-completion pass rate across the overview window, with the daily trend
 * the backend has computed all along (`getSwarmOverview.goalCompletion.trend`)
 * and no UI ever rendered.
 *
 * The buckets arrive pre-filtered: a day with no graded sessions is DROPPED
 * server-side rather than emitted as 0% — a flat line at zero would read as
 * "everything failed" when the truth is "nothing was graded". Never re-insert
 * missing days here.
 *
 * Renders nothing until the window holds a graded pass rate and at least
 * MIN_TREND_POINTS graded days — a single day is a number, not a trend.
 * Optional-chained throughout so an older backend that predates the field
 * degrades to nothing instead of throwing into the panel's ErrorBoundary.
 */
function GoalTrendStrip({
  goalCompletion,
}: {
  goalCompletion: SwarmOverview["goalCompletion"] | undefined;
}) {
  const trend = goalCompletion?.trend ?? [];
  if (
    !goalCompletion ||
    goalCompletion.passRate === null ||
    trend.length < MIN_TREND_POINTS
  ) {
    return null;
  }

  return (
    <section
      data-testid="swarm-overview-goal-trend"
      aria-label="Goal completion trend"
      className="flex items-center gap-6 rounded-xl border border-border/40 bg-muted/10 px-4 py-3"
    >
      <div className="flex shrink-0 flex-col">
        <span className="text-2xl font-semibold tabular-nums leading-none tracking-tight text-foreground">
          {formatPercent(goalCompletion.passRate)}
        </span>
        <span className="mt-1 text-xs tabular-nums text-muted-foreground">
          Goal completion · {goalCompletion.passedCount}/
          {goalCompletion.gradedCount} graded sessions ·{" "}
          {goalCompletion.runsWithGrades} run
          {goalCompletion.runsWithGrades === 1 ? "" : "s"}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <EvalSparkline
          points={trend.map((point) => point.passRate * 100)}
          pointLabels={trend.map((point) => formatTrendDay(point.dayStartMs))}
          formatValue={(value) => `${Math.round(value)}%`}
          tooltipValues={trend.map(
            (point) =>
              `${Math.round(point.passRate * 100)}% · ${point.passedCount}/${point.gradedCount} passed`,
          )}
          testId="swarm-overview-goal-trend-sparkline"
          height={30}
        />
      </div>
    </section>
  );
}

// ── swarm runs list ─────────────────────────────────────────────────────────

/** Shared with row buttons so Env / Client / Model line up. */
const SWARM_RUN_ROW_PAD = "flex w-full items-center gap-3 px-4";

/**
 * One treatment for every column header, whether it filters or is inert, so
 * Env / Client / Model / Score read as a single row of column labels rather
 * than a mix of labels and form fields.
 */
export const SWARM_COLUMN_HEADER =
  "flex w-full min-w-0 items-center justify-end gap-1 text-sm font-medium text-muted-foreground";

/**
 * Ghost select — a column label that happens to open a menu. The `dark:`
 * resets are not redundant with `bg-transparent`: tailwind-merge only drops
 * base classes carrying the same modifiers, so `SelectTrigger`'s
 * `dark:bg-input/30` / `dark:hover:bg-input/50` survive an unprefixed override
 * and painted a form-field block behind the filtering headers — and only those
 * — in dark mode.
 */
const SWARM_INLINE_SELECT_TRIGGER = cn(
  SWARM_COLUMN_HEADER,
  "h-auto min-h-0 max-w-full border-0 bg-transparent p-0 shadow-none",
  "dark:bg-transparent dark:hover:bg-transparent",
  "hover:text-foreground focus:ring-0 focus-visible:ring-0 data-[state=open]:text-foreground",
  "[&_svg]:size-3.5 [&_svg]:opacity-50"
);

function SwarmInlineSelect({
  value,
  onValueChange,
  ariaLabel,
  testId,
  children,
  triggerLabel,
}: {
  value: string;
  onValueChange: (value: string) => void;
  ariaLabel: string;
  testId: string;
  children: ReactNode;
  /** Shown in the trigger (column noun or selected value). */
  triggerLabel: string;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger
        data-testid={testId}
        aria-label={ariaLabel}
        className={SWARM_INLINE_SELECT_TRIGGER}
      >
        <span className="truncate">{triggerLabel}</span>
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}

/**
 * Inert column header. Keeps the chevron's slot as empty space so a column
 * with no filter still lines its label up with the ones that have one.
 */
function SwarmColumnLabel({
  children,
  testId,
}: {
  children: ReactNode;
  testId: string;
}) {
  return (
    <span className={SWARM_COLUMN_HEADER} data-testid={testId}>
      <span className="truncate">{children}</span>
      <span className="size-3.5 shrink-0" aria-hidden />
    </span>
  );
}

function SwarmRunsList({
  waves,
  onOpenSwarm,
  environmentsEnabled,
}: {
  waves: SwarmWave[];
  onOpenSwarm: (swarmId: string) => void;
  environmentsEnabled: boolean;
}) {
  const [clientFilter, setClientFilter] = useState<string | null>(null);
  const [envFilter, setEnvFilter] = useState<string | null>(null);

  const clientOptions = useMemo(() => {
    const names = new Set<string>();
    for (const wave of waves) {
      for (const name of waveClientNames(waveTargets(wave.runs))) {
        names.add(name);
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [waves]);

  const envOptions = useMemo(() => {
    if (!environmentsEnabled) return [] as string[];
    const names = new Set<string>();
    for (const wave of waves) {
      for (const name of waveEnvironmentNames(waveTargets(wave.runs))) {
        names.add(name);
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [waves, environmentsEnabled]);

  // Drop a selection that disappeared from the loaded window.
  useEffect(() => {
    if (clientFilter && !clientOptions.includes(clientFilter)) {
      setClientFilter(null);
    }
  }, [clientFilter, clientOptions]);
  useEffect(() => {
    if (envFilter && !envOptions.includes(envFilter)) {
      setEnvFilter(null);
    }
  }, [envFilter, envOptions]);

  const visibleWaves = useMemo(
    () =>
      filterAndSortSwarmWaves(waves, {
        clientFilter,
        envFilter: environmentsEnabled ? envFilter : null,
        sort: "newest",
      }),
    [waves, clientFilter, envFilter, environmentsEnabled]
  );

  const showEnvFilter = environmentsEnabled && envOptions.length > 0;
  const showClientFilter = clientOptions.length > 0;

  return (
    <section data-testid="swarm-overview-runs">
      {/* One inline header: Env / Client filters + Model in column slots. */}
      <header
        className="mb-2 rounded-lg border border-transparent"
        data-testid="swarm-overview-filters"
      >
        <div className={SWARM_RUN_ROW_PAD}>
          <span className="size-2 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1" aria-hidden />

          {environmentsEnabled ? (
            showEnvFilter ? (
              <div className="flex w-24 shrink-0 justify-end">
                <SwarmInlineSelect
                  value={envFilter ?? "all"}
                  onValueChange={(value) =>
                    setEnvFilter(value === "all" ? null : value)
                  }
                  ariaLabel="Filter by environment"
                  testId="swarm-overview-env-filter"
                  triggerLabel={envFilter ?? "Env"}
                >
                  <SelectItem value="all">All envs</SelectItem>
                  {envOptions.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SwarmInlineSelect>
              </div>
            ) : (
              <div className="flex w-24 shrink-0 justify-end">
                <SwarmColumnLabel testId="swarm-overview-env-label">
                  Env
                </SwarmColumnLabel>
              </div>
            )
          ) : null}

          {showClientFilter ? (
            <div className="flex w-28 shrink-0 justify-end">
              <SwarmInlineSelect
                value={clientFilter ?? "all"}
                onValueChange={(value) =>
                  setClientFilter(value === "all" ? null : value)
                }
                ariaLabel="Filter by client"
                testId="swarm-overview-client-filter"
                triggerLabel={clientFilter ?? "Client"}
              >
                <SelectItem value="all">All clients</SelectItem>
                {clientOptions.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SwarmInlineSelect>
            </div>
          ) : (
            <div className="flex w-28 shrink-0 justify-end">
              <SwarmColumnLabel testId="swarm-overview-client-label">
                Client
              </SwarmColumnLabel>
            </div>
          )}

          <div className="flex w-24 shrink-0 justify-end">
            <SwarmColumnLabel testId="swarm-overview-model-label">
              Model
            </SwarmColumnLabel>
          </div>
        </div>
      </header>

      {visibleWaves.length === 0 ? (
        <p
          className="px-4 py-8 text-center text-sm text-muted-foreground"
          data-testid="swarm-overview-filter-empty"
        >
          No swarm runs match these filters.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {visibleWaves.map((wave) => (
            <SwarmWaveRow
              key={wave.waveId}
              wave={wave}
              onOpen={() => onOpenSwarm(swarmWaveRouteId(wave))}
              environmentsEnabled={environmentsEnabled}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SwarmWaveRow({
  wave,
  onOpen,
  environmentsEnabled,
}: {
  wave: SwarmWave;
  onOpen: () => void;
  environmentsEnabled: boolean;
}) {
  const title = swarmWaveTitle(wave);
  const sessions = waveSessionTotals(wave.runs);
  const findingCount = wave.runs.reduce((n, run) => n + run.findings.length, 0);
  const personaCount = new Set(wave.runs.map((r) => r.personaName)).size;
  const targets = waveTargets(wave.runs);
  const environmentLabel = formatWaveEnvironmentLabel(targets);
  const clientLabel = formatWaveClientLabel(targets);
  const modelLabel = formatWaveModelLabel(targets);

  return (
    <li
      className="rounded-lg border border-border/60 bg-background"
      data-testid="swarm-overview-run"
      data-wave-id={wave.waveId}
      data-swarm-id={swarmWaveRouteId(wave)}
      data-journey-count={wave.runs.length}
    >
      <button
        type="button"
        className={cn(SWARM_RUN_ROW_PAD, "py-3 text-left hover:bg-muted/40")}
        onClick={onOpen}
        data-testid="swarm-overview-run-open"
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
            <span
              className="truncate text-sm font-bold tracking-tight text-foreground"
              title={title}
            >
              {title}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatJourneyRelativeTime(wave.createdAt)}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {sessions.succeeded}/{sessions.total} sessions
            {wave.runs.length === 1
              ? ` · ${wave.runs[0]!.journeyName} · ${wave.runs[0]!.personaName}`
              : ` · ${wave.runs.length} goals · ${personaCount} persona${
                  personaCount === 1 ? "" : "s"
                }`}
            {findingCount > 0
              ? ` · ${findingCount} finding${findingCount === 1 ? "" : "s"}`
              : ""}
          </p>
        </div>
        {environmentsEnabled ? (
          <span
            className="w-24 shrink-0 truncate text-right text-xs text-muted-foreground"
            data-testid="swarm-overview-run-env"
            title={environmentLabel}
          >
            {environmentLabel}
          </span>
        ) : null}
        <span
          className="flex w-28 shrink-0 justify-end"
          data-testid="swarm-overview-run-client"
          title={clientLabel}
        >
          <WaveClientLogoStrip targets={targets} />
        </span>
        <span
          className="w-24 shrink-0 truncate text-right font-mono text-xs text-muted-foreground"
          data-testid="swarm-overview-run-model"
          title={modelLabel}
        >
          {modelLabel}
        </span>
      </button>
    </li>
  );
}

/**
 * Rubric findings for a Swarm Run wave — used on the detail Insights tab.
 * Journeys without findings are omitted; this is not a goal catalog.
 */
export function SwarmWaveFindingsList({
  runs,
  onOpenSession,
}: {
  runs: readonly SwarmOverviewRun[];
  onOpenSession: (sessionId: string) => void;
}) {
  const runsWithFindings = runs.filter((run) => run.findings.length > 0);
  if (runsWithFindings.length === 0) {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="swarm-overview-no-findings"
      >
        No findings for this run.
      </p>
    );
  }
  return (
    <div
      className="flex flex-col gap-3"
      data-testid="swarm-overview-wave-findings"
    >
      {runsWithFindings.map((run) => (
        <WaveFindingsBlock
          key={run.runId}
          run={run}
          showJourneyLabel={runsWithFindings.length > 1}
          onOpenSession={onOpenSession}
        />
      ))}
    </div>
  );
}

function WaveFindingsBlock({
  run,
  showJourneyLabel,
  onOpenSession,
}: {
  run: SwarmOverviewRun;
  showJourneyLabel: boolean;
  onOpenSession: (sessionId: string) => void;
}) {
  return (
    <div
      data-testid="swarm-overview-journey"
      data-journey-id={run.journeyRefId}
      data-run-id={run.runId}
    >
      {showJourneyLabel ? (
        <p className="mb-1.5 truncate text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground/80">{run.journeyName}</span>
          {" · "}
          {run.personaName}
        </p>
      ) : null}
      <div className="flex flex-col gap-2" data-testid="swarm-overview-findings">
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
 * bounded at hosts × sessionsPerTarget (≤50 rows), so that costs at most a page
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
          No session in this run carries a failing verdict for this check.
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
          Open Personas and run one of your goals. Once a run finishes, its
          outcomes and any failing checks show up here.
        </p>
      </div>
    </div>
  );
}
