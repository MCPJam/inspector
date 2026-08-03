import { useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import type {
  SessionOutcome,
  SessionSentiment,
  UsageFilterState,
  UsageFilterChip,
} from "@/hooks/chatbox-usage-filters";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";

export type InsightsSourceType = "chatbox";

/**
 * Which surface the insights read from. Chatbox insights key on the chatbox;
 * swarm insights key on the project, because swarm sessions belong to a
 * project, not a chatbox. The two scopes hit different Convex queries over the
 * same substrate, so everything downstream of the hook is scope-blind.
 */
export type InsightsScope =
  | { kind: "chatbox"; chatboxId: string }
  | { kind: "swarm"; projectId: string };

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
  isStale: boolean;
};

// One closed vocabulary, one declaration. `chatbox-usage-filters` derives
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
   * chatbox surface (no rubric exists there); optional so a response from a
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

export function useUsageInsights({
  sourceId = null,
  scope,
  filters,
  enabled = true,
  threadsEnabled,
  breakdownEnabled,
}: {
  sourceType?: InsightsSourceType;
  /** Legacy chatbox key; shorthand for `scope: { kind: "chatbox", … }`. */
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
    scope ?? (sourceId ? { kind: "chatbox", chatboxId: sourceId } : null);
  const isSwarm = effectiveScope?.kind === "swarm";

  // The thread list is a chatbox-surface concern; the swarm Sessions browser
  // has its own project-scoped listing, so a swarm scope never subscribes.
  const chatboxArgs =
    wantThreads && effectiveScope?.kind === "chatbox"
      ? ({
          chatboxId: effectiveScope.chatboxId,
          limit: 100,
          includeInternal: true,
        } as any)
      : "skip";

  const breakdownArgs =
    wantBreakdown && effectiveScope
      ? ({
          ...(effectiveScope.kind === "swarm"
            ? { projectId: effectiveScope.projectId }
            : { chatboxId: effectiveScope.chatboxId }),
          filters: toServerFilters(filters),
        } as any)
      : "skip";

  const threads = useQuery("chatSessions:listByChatbox" as any, chatboxArgs) as
    | SharedChatThread[]
    | undefined;

  // `getUsageBreakdown` already carries `themes` + `latestRun`, so we don't
  // subscribe to `listClustersByChatbox` — UsageInsightsStrip and the rebuild
  // button both read everything they need from `breakdown`.
  const breakdown = useQuery(
    (isSwarm
      ? "chatSessions:getSwarmUsageBreakdown"
      : "chatSessions:getUsageBreakdown") as any,
    breakdownArgs,
  ) as UsageBreakdown | null | undefined;

  const rebuildChatbox = useMutation(
    "chatSessions:rebuildChatboxInsights" as any,
  ) as unknown as (args: { chatboxId: string; force?: boolean }) => Promise<{
    runId: string;
    status: ClusterRunStatus;
    alreadyRunning: boolean;
  }>;
  const rebuildSwarm = useMutation(
    "chatSessions:rebuildSwarmInsights" as any,
  ) as unknown as (args: { projectId: string; force?: boolean }) => Promise<{
    runId: string;
    status: ClusterRunStatus;
    alreadyRunning: boolean;
  }>;

  // Scope-bound so callers don't restate the key the hook already holds — the
  // caller restating it is exactly how a swarm surface would accidentally
  // trigger a chatbox rebuild.
  const rebuild = useCallback(
    async (args?: { force?: boolean }) => {
      if (!effectiveScope) {
        throw new Error("No insights scope to rebuild");
      }
      return effectiveScope.kind === "swarm"
        ? rebuildSwarm({ projectId: effectiveScope.projectId, ...args })
        : rebuildChatbox({ chatboxId: effectiveScope.chatboxId, ...args });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scope identity is its key fields
    [
      effectiveScope?.kind,
      effectiveScope?.kind === "swarm"
        ? effectiveScope.projectId
        : effectiveScope?.chatboxId,
      rebuildChatbox,
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
  const args =
    enabled && scope
      ? ({
          ...(scope.kind === "swarm"
            ? { projectId: scope.projectId }
            : { chatboxId: scope.chatboxId }),
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
    isLoading: enabled && !!scope && result === undefined,
  };
}
