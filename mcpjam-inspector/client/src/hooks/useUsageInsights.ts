import { useCallback, useMemo } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import type {
  SessionOutcome,
  SessionSentiment,
  UsageFilterState,
  UsageFilterChip,
} from "@/hooks/scenario-usage-filters";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";

export type InsightsSourceType = "scenario";

/**
 * Which surface the insights read from. Scenario insights key on the scenario;
 * swarm insights key on the project (and optionally a wave's journey-run ids),
 * because swarm sessions belong to a project, not a scenario; benchmark
 * insights key on the RUN, because a benchmark's cohort is exactly the traces
 * one exam produced and nothing else. The three scopes hit different Convex
 * queries over the same substrate, so everything downstream of the hook is
 * scope-blind.
 *
 * The benchmark scope is deliberately narrower than the other two:
 *
 *   - It has no thread list. There is no benchmark Sessions browser, and a
 *     benchmark's traces are read through its own run detail.
 *   - It has no TOPIC MAP. A neighbour graph over one exam's repetitions draws
 *     "these two runs of the same case are similar" and nothing else, so the
 *     backend does not build one and the client must not ask for one.
 *   - It has no per-selection drill-down query yet. A benchmark node click is
 *     inert rather than pointed at the swarm query, which would silently
 *     narrow a PROJECT's sessions and present them as this run's.
 */
export type InsightsScope =
  | { kind: "scenario"; scenarioId: string }
  | { kind: "swarm"; projectId: string; journeyRunIds?: string[] }
  | { kind: "benchmark"; benchmarkRunId: string };

export type FeedbackBucketCount = {
  segment: string;
  positive: number;
  neutral: number;
  negative: number;
  none: number;
};

export type BreakdownBucket = {
  key: string;
  label: string;
  count: number;
};

/**
 * Why the theme columns read the way they do, when that needs saying.
 * `draft`: themes proposed from fewer sessions than the stable catalog needs;
 * they are replaced as sessions arrive. `needs_review`: a catalog is full.
 */
export type InsightsThemesReason = "draft" | "needs_review" | null;

export type InsightsAnalysisSummary = {
  total: number;
  analyzed: number;
  /**
   * Sessions with no analysis yet whose automatic pass is still coming. Also
   * counted in `pending`. Absent from backends before B5.
   */
  owed?: number;
  /** Analyzed before the outcome could be asserted; the outcome follows. */
  provisional?: number;
  /** When the next automatic pass is due (ms epoch), or null. */
  nextAnalysisAt?: number | null;
  themes?: { reason: InsightsThemesReason; sessionsUntilStable: number };
  pending: number;
  running: number;
  failed: number;
  skipped: number;
  deferred: number;
  awaitingTaxonomy: number;
  unassigned: number;
  staleAssignments: number;
  projectionPending: number;
  projectionFailed: number;
  deferredUntil: number | null;
  lastAnalyzedAt: number | null;
  failures: Record<string, number>;
  skips: Record<string, number>;
  sampled: boolean;
  taxonomies: Array<{
    dimension: string;
    version: number;
    status: string;
    assigned: number;
    unassigned: number;
    sampleSize: number;
    errorCode?: string;
    /** The catalog is a draft (see `InsightsThemesReason`). */
    draft?: boolean;
  }>;
};

export type ClusterRunStatus = "queued" | "running" | "done" | "failed";

export type RebuildResult = {
  runId?: string;
  status: ClusterRunStatus;
  alreadyRunning: boolean;
};

// One closed vocabulary, one declaration. `scenario-usage-filters` derives
// `SessionOutcome` from `SESSION_OUTCOMES`; re-exporting rather than restating
// it here means a new server outcome cannot leave the drill-down types agreeing
// with nothing. Re-exported (not just imported) because consumers of the
// drill-down hook reasonably expect the type alongside it.
export type { SessionOutcome, SessionSentiment };

export type SankeyStage =
  | "goal"
  | "behavior"
  | "outcome"
  | "sentiment"
  | `question:${string}`;

export type InsightsSankeyNode<S extends string = SankeyStage> = {
  questionVersion?: number;
  /** `${stage}:${key}` — unique across stages, whose keys can collide. */
  id: string;
  stage: S;
  key: string;
  label: string;
  count: number;
  /**
   * False for the folded goal tail and the unlabeled goal node: no chip can
   * express a union of clusters or the absence of one. Render these inert.
   */
  clickable: boolean;
};

export type InsightsSankeyLink = {
  source: string;
  target: string;
  count: number;
  /**
   * Sessions on this link whose outcome and sentiment ENUMS disagree. Always 0
   * outside the outcome → sentiment pair, and computed server-side: themes are
   * emergent, so only the closed enums can answer whether two labels disagree.
   */
  discordantCount?: number;
};

export type InsightsSankey<S extends string = SankeyStage> = {
  stages?: Array<{
    id: S;
    label: string;
    questionId?: string;
    version?: number;
  }>;
  nodes: InsightsSankeyNode<S>[];
  links: InsightsSankeyLink[];
  foldedGoalCount: number;
  /**
   * Themes collapsed into `__other__` per stage. Absent on responses from a
   * server that only folded the goal column — read `foldedGoalCount` then, or
   * the disclosure disappears while a fold is still in effect.
   */
  foldedByStage?: Partial<Record<S, number>>;
};

export type OutcomeCounts = Record<SessionOutcome, number>;

/** One row of the goal × outcome grid. */
export type GoalFacet = {
  clusterId: string;
  label: string;
  total: number;
  outcomes: OutcomeCounts;
  /**
   * Sessions with NO recorded outcome. Distinct from `outcomes.unclear`:
   * `unclear` is a verdict, this is the absence of one.
   */
  unlabeled: number;
  /** Null when nothing in the row is labeled — a zero denominator is not 0%. */
  unresolvedRate: number | null;
  errorRate: number | null;
  retryRate: number;
  toolDistribution: BreakdownBucket[];
  pathDistribution: BreakdownBucket[];
  distinctPathCount: number;
  /** Shannon entropy (bits) over this goal's route distribution. */
  routingEntropy: number | null;
};

export type OutcomeFeedbackCalibration = {
  outcome: SessionOutcome;
  sessions: number;
  rated: number;
  negative: number;
  /** Null when nobody rated. Not 0. */
  negativeRate: number | null;
};

/**
 * Scan metadata. When `truncated` is true every rate in the breakdown is
 * conditional on the scanned window and must not render as a bare percentage.
 */
export type UsageScanMeta = {
  scanned: number;
  matched: number;
  truncated: boolean;
  maxSessions: number;
  windowEndAt: number | null;
  windowStartAt: number | null;
};

/**
 * One criterion's tally. The three counts are disjoint and sum to the
 * criterion's denominator — sessions from runs with NO rubric are excluded
 * upstream rather than counted as ungraded.
 */
export type CriterionFacet = {
  criterionId: string;
  label?: string;
  kind?: string;
  passCount: number;
  failCount: number;
  /** No completed verdict: grading pending or grading failed. NOT "failed it". */
  ungradedCount: number;
};

export type UsageBreakdown = {
  analysis?: InsightsAnalysisSummary;
  themes: Array<{ clusterId: string; label: string; count: number }>;
  userBreakdown: FeedbackBucketCount[];
  deviceBreakdown: BreakdownBucket[];
  languageBreakdown: BreakdownBucket[];
  modelBreakdown: BreakdownBucket[];
  outcomeBreakdown: BreakdownBucket[];
  frictionBreakdown: BreakdownBucket[];
  behaviorTagBreakdown: BreakdownBucket[];
  goalFacets: GoalFacet[];
  /**
   * Four-stage session flow. Optional so a response from a server predating it
   * still renders the rest of the panel instead of throwing.
   */
  sankey?: InsightsSankey;
  questionBreakdown?: Array<{
    questionId: string;
    label: string;
    version: number;
    yes: number;
    no: number;
    unanswered: number;
  }>;
  labeledOutcomeCount: number;
  outcomeFeedbackCalibration: OutcomeFeedbackCalibration[];
  /**
   * Per-criterion pass/fail tallies across the scanned sessions. `[]` on the
   * scenario surface (no rubric exists there); optional so a response from a
   * server predating it still renders the rest of the panel.
   *
   * `label` / `kind` are resolved server-side from the RUN SNAPSHOTS the
   * scanned sessions belong to — the definitions they were actually graded
   * against — so a criterion renamed after a run still reads as it did then.
   * Both absent ⇒ no run in the window named this id; the UI falls back to the
   * raw id, which is ugly but never wrong.
   */
  criterionBreakdown?: CriterionFacet[];
  totalSessions: number;
  /** Optional so a stale/older server response still renders. */
  scan?: UsageScanMeta;
};

/**
 * Serializes a UsageFilterState to the Convex argument shape. We strip the
 * optional `label` on chips because the server doesn't need it (it's only for
 * rendering dismiss buttons in the UI).
 */
export function toServerFilters(state: UsageFilterState) {
  return {
    preset: state.preset,
    chips: state.chips.map((chip): UsageFilterChip => {
      if (chip.kind === "cluster") {
        // The axis is part of the filter, not decoration: without it the
        // server reads every theme chip as a GOAL cluster, so a behavior or
        // sentiment selection silently queries the wrong column and returns an
        // unrelated cohort. Only `label` is dropped — that is render-only.
        return {
          kind: "cluster",
          clusterId: chip.clusterId,
          ...(chip.dimension ? { dimension: chip.dimension } : {}),
        };
      }
      if (chip.kind === "question")
        return {
          kind: "question",
          questionId: chip.questionId,
          version: chip.version,
          value: chip.value,
        };
      return { kind: "dimension", key: chip.key, value: chip.value };
    }),
  };
}

/**
 * The one key that names a scope's cohort, in the arg shape its queries take.
 *
 * Written once and shared by the breakdown and the drill-down rather than
 * spelled out at each call site: with three scopes, a `kind === "swarm" ? … :
 * …` ternary silently sends a benchmark scope down the SCENARIO arm, which
 * queries with `scenarioId: undefined` and answers about a cohort nobody
 * asked for. A `switch` over the union is what makes a fourth scope a compile
 * error instead of a wrong answer.
 */
function scopeKeyArgs(scope: InsightsScope): Record<string, unknown> {
  switch (scope.kind) {
    case "swarm":
      return {
        projectId: scope.projectId,
        ...(scope.journeyRunIds?.length
          ? { journeyRunIds: scope.journeyRunIds }
          : {}),
      };
    case "benchmark":
      return { benchmarkRunId: scope.benchmarkRunId };
    case "scenario":
      return { scenarioId: scope.scenarioId };
  }
}

/** The one id a scope is bound to, for memo keys. Never sent to a query. */
function scopeIdentity(scope: InsightsScope): string {
  switch (scope.kind) {
    case "swarm":
      return scope.projectId;
    case "benchmark":
      return scope.benchmarkRunId;
    case "scenario":
      return scope.scenarioId;
  }
}

/**
 * The benchmark analyzer's own state, as `getBenchmarkUsageBreakdown` reports
 * it. Its statuses are its own (`generating | ready | failed`) and its counts
 * are traces rather than sessions.
 */
type InferredExperienceState = {
  status: "generating" | "ready" | "failed";
  traceCount?: number;
  failureCode?: string | null;
  generatedAt?: number;
  /**
   * False when the stored pass read a different set of traces than the query
   * just scanned. The backend WITHHOLDS the inferred columns in that case, so
   * the honest state is "not analyzed" — offering another pass is right, and
   * showing a stale reading as current would not be.
   */
  current?: boolean;
};

/** Adapt benchmark coverage to the same summary consumed by scenario and swarm views. */
export function adaptBenchmarkAnalysisState(
  breakdown: UsageBreakdown | null | undefined,
): UsageBreakdown | null | undefined {
  if (!breakdown) return breakdown;
  const pass = (
    breakdown as UsageBreakdown & {
      inferredExperience?: InferredExperienceState | null;
    }
  ).inferredExperience;
  if (pass === undefined) return breakdown;
  if (!pass || pass.current === false)
    return { ...breakdown, analysis: undefined };
  const total = pass.traceCount ?? breakdown.totalSessions;
  return {
    ...breakdown,
    analysis: {
      total,
      analyzed: pass.status === "ready" ? total : 0,
      pending: pass.status === "generating" ? total : 0,
      running: 0,
      failed: pass.status === "failed" ? total : 0,
      failures:
        pass.status === "failed"
          ? { [pass.failureCode ?? "analysis_failed"]: total }
          : {},
      skipped: 0,
      skips: {},
      deferred: 0,
      deferredUntil: null,
      awaitingTaxonomy: 0,
      unassigned: 0,
      staleAssignments: 0,
      projectionPending: 0,
      projectionFailed: 0,
      lastAnalyzedAt: pass.generatedAt ?? null,
      sampled: false,
      taxonomies: [],
    },
  };
}

/** The breakdown query each scope reads. Same substrate, three cohorts. */
const BREAKDOWN_QUERIES: Record<InsightsScope["kind"], string> = {
  scenario: "chatSessions:getUsageBreakdown",
  swarm: "chatSessions:getSwarmUsageBreakdown",
  benchmark: "chatSessions:getBenchmarkUsageBreakdown",
};

/**
 * Only real options cross into the mutation.
 *
 * `onClick={rebuild}` type-checks, because a zero-argument callback is
 * assignable to a click handler, but React hands it a synthetic event at
 * runtime. Spreading that into the mutation payload made Convex throw
 * "Converting circular structure to JSON" (the fiber closes a circle through
 * the DOM node), so "Analyze sessions" never started.
 *
 * This lives at the serialization boundary rather than in `useInsightsRebuild`,
 * because `rebuild` is returned publicly and callers reach it directly without
 * passing through that hook.
 *
 * It REJECTS event-shaped values rather than allowlisting the options it knows.
 * An allowlist would silently drop any option added to `rebuild` later, and the
 * mutation would run with server defaults while the surface toasted success.
 */
export type RebuildOptions = {
  force?: boolean;
  /**
   * Analyze now: treat the scope's quiet sessions as finished, so their
   * outcome is asserted without waiting out the idle window. Scenario scope
   * only; the swarm rebuild does not take it.
   */
  settled?: boolean;
};

function rebuildOptionsOnly(
  args?: RebuildOptions,
): RebuildOptions | undefined {
  if (args == null || typeof args !== "object") return undefined;
  const candidate = args as Record<string, unknown>;
  // A React synthetic event carries these; an options object does not.
  if ("nativeEvent" in candidate || "currentTarget" in candidate) {
    return undefined;
  }
  return args;
}

export function useUsageInsights({
  sourceId = null,
  scope,
  filters,
  enabled = true,
  threadsEnabled,
  breakdownEnabled,
}: {
  sourceType?: InsightsSourceType;
  /** Legacy scenario key; shorthand for `scope: { kind: "scenario", … }`. */
  sourceId?: string | null;
  /** Takes precedence over `sourceId` when both are given. */
  scope?: InsightsScope | null;
  filters: UsageFilterState;
  enabled?: boolean;
  /**
   * Per-query gates. The thread list and the breakdown back different tabs, so
   * a caller that only needs one should not subscribe to both. Both default to
   * `enabled` so existing callers are unaffected.
   */
  threadsEnabled?: boolean;
  breakdownEnabled?: boolean;
}) {
  const wantThreads = threadsEnabled ?? enabled;
  const wantBreakdown = breakdownEnabled ?? enabled;

  const effectiveScope: InsightsScope | null =
    scope ?? (sourceId ? { kind: "scenario", scenarioId: sourceId } : null);

  // The thread list is a scenario-surface concern; the swarm Sessions browser
  // has its own project-scoped listing, so a swarm scope never subscribes.
  // Filters go to the SERVER, not just to a client-side pass afterward. The
  // query applies them inside its index walk while filling the page; the page
  // caps at 100 rows, so filtering only on the client would narrow that page
  // instead of the scenario, silently hiding every older session that matches.
  const scenarioArgs =
    wantThreads && effectiveScope?.kind === "scenario"
      ? ({
          scenarioId: effectiveScope.scenarioId,
          limit: 100,
          includeInternal: true,
          ...(filters ? { filters: toServerFilters(filters) } : {}),
        } as any)
      : "skip";

  const breakdownArgs =
    wantBreakdown && effectiveScope
      ? ({
          ...scopeKeyArgs(effectiveScope),
          filters: toServerFilters(filters),
        } as any)
      : "skip";

  const threads = useQuery(
    "chatSessions:listByScenario" as any,
    scenarioArgs,
  ) as SharedChatThread[] | undefined;

  // `getUsageBreakdown` already carries `themes` + `analysis`, so we don't
  // subscribe to `listClustersByScenario` — the themes chips, the freshness
  // chip, and the rebuild button all read what they need from `breakdown`.
  const rawBreakdown = useQuery(
    BREAKDOWN_QUERIES[effectiveScope?.kind ?? "scenario"] as any,
    breakdownArgs,
  ) as UsageBreakdown | null | undefined;

  /**
   * The benchmark scope reports its analysis state as `inferredExperience`;
   * the scenario and swarm scopes report theirs as `analysis`, and every
   * component downstream reads `analysis`. Left unadapted, a benchmark looks
   * permanently un-analyzed: it never shows the in-flight pass and keeps
   * offering to pay for another one after the columns are already drawn.
   *
   * Adapted HERE rather than in the chart, so "same substrate, scope-blind"
   * stays true of everything below this hook — a benchmark-only prop on the
   * shared Sankey would make every future consumer handle two shapes.
   */
  const breakdown = useMemo(
    () => adaptBenchmarkAnalysisState(rawBreakdown),
    [rawBreakdown],
  );

  const rebuildScenario = useMutation(
    "chatSessions:rebuildScenarioInsights" as any,
  ) as unknown as (args: {
    scenarioId: string;
    force?: boolean;
    settled?: boolean;
  }) => Promise<RebuildResult>;
  const rebuildSwarm = useMutation(
    "chatSessions:rebuildSwarmInsights" as any,
  ) as unknown as (args: {
    projectId: string;
    force?: boolean;
    /** All three knobs — swarm rebuilds materialize a topic map. */
  }) => Promise<RebuildResult>;
  /**
   * An ACTION, not a mutation, and the only paid one here.
   *
   * The benchmark diagram's first column is pinned metadata read at query time
   * and costs nothing; this buys the other three. It takes no tuning — there
   * is no topic map to materialize — and it can refuse, which the adapter
   * below turns into an explicit failure rather than a silent no-op.
   */
  const generateBenchmarkFlow = useAction(
    "scenarioClusters:generateBenchmarkFlowInsights" as any,
  ) as unknown as (args: { benchmarkRunId: string }) => Promise<
    | {
        status: "ready" | "generating";
        traceDigest: string;
        traceCount: number;
      }
    | { status: "unavailable"; reason: string }
  >;

  // Scope-bound so callers don't restate the key the hook already holds — the
  // caller restating it is exactly how a swarm surface would accidentally
  // trigger a scenario rebuild.
  const rebuild = useCallback(
    async (args?: RebuildOptions) => {
      if (!effectiveScope) {
        throw new Error("No insights scope to rebuild");
      }
      if (effectiveScope.kind === "benchmark") {
        const outcome = await generateBenchmarkFlow({
          benchmarkRunId: effectiveScope.benchmarkRunId,
        });
        if (outcome.status === "unavailable") {
          // Thrown rather than returned as a `RebuildResult`: every field of
          // that shape would be a fiction here, and reporting a refusal as
          // "rebuild queued" is how a caller ends up waiting for a pass that
          // was never started.
          throw new Error(outcome.reason);
        }
        // A reading already paid for comes back `ready` from the cache and is
        // NOT a fresh run, which is exactly what `alreadyRunning` means to
        // every caller of this hook.
        return {
          runId: outcome.traceDigest,
          status: outcome.status === "ready" ? "done" : "running",
          alreadyRunning: outcome.status === "ready",
        } satisfies RebuildResult;
      }
      // Sanitize once, here, because this is where the payload crosses into
      // Convex and gets serialized.
      const opts = rebuildOptionsOnly(args);
      if (effectiveScope.kind === "swarm") {
        return rebuildSwarm({
          projectId: effectiveScope.projectId,
          ...(opts?.force !== undefined ? { force: opts.force } : {}),
        });
      }
      return rebuildScenario({
        scenarioId: effectiveScope.scenarioId,
        ...opts,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scope identity is its key fields
    [
      effectiveScope?.kind,
      effectiveScope ? scopeIdentity(effectiveScope) : null,
      generateBenchmarkFlow,
      rebuildScenario,
      rebuildSwarm,
    ],
  );

  return {
    threads,
    breakdown,
    rebuild,
  };
}

export type GoalOutcomeDrilldown = {
  sessions: SharedChatThread[];
  nextBefore: number | null;
  /** Server-counted total for the selection; matches the clicked node's count. */
  total: number;
  totalTruncated: boolean;
};

/**
 * Server-filtered, paginated sessions for one flow selection.
 *
 * The diagram renders exact counts, so a click on "62 unresolved" has to be able
 * to page exactly those 62 rows. The insights list's `limit: 100` +
 * client-side filter cannot back that: it shows a silent subset whose total
 * disagrees with the node the user clicked.
 *
 * `clusterId` is optional: a click on a behavior, outcome, or sentiment node has
 * no goal, and the server narrows by chips alone in that case. `outcome: null`
 * requests the sessions with no recorded outcome.
 */
export function useGoalOutcomeDrilldown({
  scope,
  clusterId,
  outcome,
  filters,
  limit = 50,
  before,
  enabled = true,
}: {
  scope: InsightsScope | null;
  clusterId: string | null;
  outcome: SessionOutcome | null | undefined;
  filters?: UsageFilterState;
  limit?: number;
  before?: number;
  enabled?: boolean;
}) {
  // A benchmark scope has no drill-down query of its own yet. It SKIPS rather
  // than borrowing the swarm one: that query narrows a PROJECT's sessions, and
  // answering a benchmark node click with them would present another cohort's
  // rows as this run's traces.
  const args =
    enabled && scope && scope.kind !== "benchmark"
      ? ({
          ...scopeKeyArgs(scope),
          ...(clusterId ? { clusterId } : {}),
          // `undefined` means "any outcome"; `null` means "no outcome
          // recorded". They are different selections, so the distinction has to
          // survive serialization rather than being collapsed here.
          ...(outcome === undefined ? {} : { outcome }),
          ...(filters ? { filters: toServerFilters(filters) } : {}),
          limit,
          ...(before === undefined ? {} : { before }),
        } as any)
      : "skip";

  const result = useQuery(
    (scope?.kind === "swarm"
      ? "chatSessions:listSwarmSessionsBySelection"
      : "chatSessions:listSessionsByGoalOutcome") as any,
    args,
  ) as GoalOutcomeDrilldown | undefined;

  return {
    drilldown: result,
    // A skipped scope is never loading. Without the exclusion a benchmark
    // scope reports a permanent spinner over a query that was never issued.
    isLoading:
      enabled && !!scope && scope.kind !== "benchmark" && result === undefined,
  };
}
