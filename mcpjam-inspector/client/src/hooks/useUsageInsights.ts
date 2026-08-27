import { useCallback } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import type {
  SessionOutcome,
  SessionSentiment,
  UsageFilterState,
  UsageFilterChip,
} from "@/hooks/scenario-usage-filters";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";
import type { ClusterTuning } from "@/lib/cluster-tuning";

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

export type ClusterRunStatus = "queued" | "running" | "done" | "failed";

export type RebuildResult = {
  runId: string;
  status: ClusterRunStatus;
  alreadyRunning: boolean;
  /**
   * A rebuild was already in flight AND it was queued with different settings,
   * so the requested tuning was NOT applied.
   *
   * The server refuses to stack a second run in one scope (theme rows are
   * replaced in place), so this is the difference between "your rebuild is
   * already running" and "your new settings were dropped on the floor" — and
   * the caller has to say which one happened.
   *
   * Optional for backends predating the field.
   */
  tuningMismatch?: boolean;
};

export type ClusterRunState = {
  _id: string;
  status: ClusterRunStatus;
  startedAt: number;
  finishedAt: number | null;
  sessionCount: number;
  clusterCount: number;
  errorMessage: string | null;
  model?: string | null;
  topicMapVersion?: number | null;
  /** Null on runs predating the goal/outcome split. */
  signalsVersion?: number | null;
  signalsCacheHitCount?: number | null;
  embeddingCacheHitCount?: number | null;
  edgeCount?: number;
  sampleNodeCount?: number;
  unmappedSessionCount?: number;
  isSampled?: boolean;
  topicMapReady?: boolean;
  /**
   * The clustering parameters this run used. The server always sends a fully
   * resolved record, so this is what seeds the tuning control — the current
   * state of the world is "whatever the last run did", not a separate setting.
   *
   * Optional only for backends predating the field; `resolveClusterTuning`
   * turns absence into the defaults, which is what those runs used.
   */
  tuning?: ClusterTuning;
  isStale: boolean;
};

// One closed vocabulary, one declaration. `scenario-usage-filters` derives
// `SessionOutcome` from `SESSION_OUTCOMES`; re-exporting rather than restating
// it here means a new server outcome cannot leave the drill-down types agreeing
// with nothing. Re-exported (not just imported) because consumers of the
// drill-down hook reasonably expect the type alongside it.
export type { SessionOutcome, SessionSentiment };

/**
 * The first `signalsVersion` whose runs cluster every axis. Below this only the
 * goal column has themes, so the other three render entirely unlabeled — worth
 * prompting a rebuild rather than showing blank columns with no explanation.
 */
export const SIGNALS_VERSION_WITH_THEMES = 3;

export type SankeyStage = "goal" | "behavior" | "outcome" | "sentiment";

export type InsightsSankeyNode = {
  /** `${stage}:${key}` — unique across stages, whose keys can collide. */
  id: string;
  stage: SankeyStage;
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

export type InsightsSankey = {
  nodes: InsightsSankeyNode[];
  links: InsightsSankeyLink[];
  foldedGoalCount: number;
  /**
   * Themes collapsed into `__other__` per stage. Absent on responses from a
   * server that only folded the goal column — read `foldedGoalCount` then, or
   * the disclosure disappears while a fold is still in effect.
   */
  foldedByStage?: Partial<Record<SankeyStage, number>>;
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
  latestRun: ClusterRunState | null;
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

/** The breakdown query each scope reads. Same substrate, three cohorts. */
const BREAKDOWN_QUERIES: Record<InsightsScope["kind"], string> = {
  scenario: "chatSessions:getUsageBreakdown",
  swarm: "chatSessions:getSwarmUsageBreakdown",
  benchmark: "chatSessions:getBenchmarkUsageBreakdown",
};

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

  const threads = useQuery("chatSessions:listByScenario" as any, scenarioArgs) as
    | SharedChatThread[]
    | undefined;

  // `getUsageBreakdown` already carries `themes` + `latestRun`, so we don't
  // subscribe to `listClustersByScenario` — the themes chips, the freshness
  // chip, and the rebuild button all read what they need from `breakdown`.
  const breakdown = useQuery(
    BREAKDOWN_QUERIES[effectiveScope?.kind ?? "scenario"] as any,
    breakdownArgs
  ) as UsageBreakdown | null | undefined;

  const rebuildScenario = useMutation(
    "chatSessions:rebuildScenarioInsights" as any
  ) as unknown as (args: {
    scenarioId: string;
    force?: boolean;
    tuning?: ClusterTuning;
  }) => Promise<RebuildResult>;
  const rebuildSwarm = useMutation(
    "chatSessions:rebuildSwarmInsights" as any
  ) as unknown as (args: {
    projectId: string;
    force?: boolean;
    /** All three knobs — swarm rebuilds materialize a topic map. */
    tuning?: ClusterTuning;
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
    "scenarioClusters:generateBenchmarkFlowInsights" as any
  ) as unknown as (args: { benchmarkRunId: string }) => Promise<
    | { status: "ready" | "generating"; traceDigest: string; traceCount: number }
    | { status: "unavailable"; reason: string }
  >;

  // Scope-bound so callers don't restate the key the hook already holds — the
  // caller restating it is exactly how a swarm surface would accidentally
  // trigger a scenario rebuild.
  const rebuild = useCallback(
    async (args?: { force?: boolean; tuning?: ClusterTuning }) => {
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
      if (effectiveScope.kind === "swarm") {
        return rebuildSwarm({
          projectId: effectiveScope.projectId,
          ...(args?.force !== undefined ? { force: args.force } : {}),
          ...(args?.tuning ? { tuning: args.tuning } : {}),
        });
      }
      return rebuildScenario({ scenarioId: effectiveScope.scenarioId, ...args });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scope identity is its key fields
    [
      effectiveScope?.kind,
      effectiveScope ? scopeIdentity(effectiveScope) : null,
      generateBenchmarkFlow,
      rebuildScenario,
      rebuildSwarm,
    ]
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
    args
  ) as GoalOutcomeDrilldown | undefined;

  return {
    drilldown: result,
    // A skipped scope is never loading. Without the exclusion a benchmark
    // scope reports a permanent spinner over a query that was never issued.
    isLoading:
      enabled &&
      !!scope &&
      scope.kind !== "benchmark" &&
      result === undefined,
  };
}
