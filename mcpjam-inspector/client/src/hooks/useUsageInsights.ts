import { useMutation, useQuery } from "convex/react";
import type {
  UsageFilterState,
  UsageFilterChip,
} from "@/hooks/chatbox-usage-filters";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";

export type InsightsSourceType = "chatbox";

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

/** Mirrors `SESSION_OUTCOMES` on the server. */
export type SessionOutcome =
  | "completed"
  | "partial"
  | "unresolved"
  | "errored"
  | "unclear";

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
  labeledOutcomeCount: number;
  outcomeFeedbackCalibration: OutcomeFeedbackCalibration[];
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
function toServerFilters(state: UsageFilterState) {
  return {
    preset: state.preset,
    chips: state.chips.map((chip): UsageFilterChip => {
      if (chip.kind === "cluster") {
        return { kind: "cluster", clusterId: chip.clusterId };
      }
      return { kind: "dimension", key: chip.key, value: chip.value };
    }),
  };
}

export function useUsageInsights({
  sourceId,
  filters,
  enabled = true,
  threadsEnabled,
  breakdownEnabled,
}: {
  sourceType?: InsightsSourceType;
  sourceId: string | null;
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

  const chatboxArgs =
    wantThreads && sourceId
      ? ({
          chatboxId: sourceId,
          limit: 100,
          includeInternal: true,
        } as any)
      : "skip";

  const breakdownArgs =
    wantBreakdown && sourceId
      ? ({
          chatboxId: sourceId,
          filters: toServerFilters(filters),
        } as any)
      : "skip";

  const threads = useQuery(
    "chatSessions:listByChatbox" as any,
    chatboxArgs,
  ) as SharedChatThread[] | undefined;

  // `getUsageBreakdown` already carries `themes` + `latestRun`, so we don't
  // subscribe to `listClustersByChatbox` — UsageInsightsStrip and the rebuild
  // button both read everything they need from `breakdown`.
  const breakdown = useQuery(
    "chatSessions:getUsageBreakdown" as any,
    breakdownArgs,
  ) as UsageBreakdown | null | undefined;

  const rebuild = useMutation(
    "chatSessions:rebuildChatboxInsights" as any,
  ) as unknown as (args: {
    chatboxId: string;
    force?: boolean;
  }) => Promise<{ runId: string; status: ClusterRunStatus; alreadyRunning: boolean }>;

  return {
    threads,
    breakdown,
    rebuild,
  };
}

export type GoalOutcomeDrilldown = {
  sessions: SharedChatThread[];
  nextBefore: number | null;
  /** Server-counted total for the cell; matches the grid cell's count. */
  total: number;
  totalTruncated: boolean;
};

/**
 * Server-filtered, paginated sessions for one goal × outcome cell.
 *
 * The grid renders exact counts, so a click on "62 unresolved" has to be able
 * to page exactly those 62 rows. The insights list's `limit: 100` +
 * client-side filter cannot back that: it shows a silent subset whose total
 * disagrees with the cell the user clicked.
 *
 * `outcome: null` requests the "not analyzed" cell.
 */
export function useGoalOutcomeDrilldown({
  chatboxId,
  clusterId,
  outcome,
  filters,
  limit = 50,
  before,
  enabled = true,
}: {
  chatboxId: string | null;
  clusterId: string | null;
  outcome: SessionOutcome | null | undefined;
  filters?: UsageFilterState;
  limit?: number;
  before?: number;
  enabled?: boolean;
}) {
  const args =
    enabled && chatboxId && clusterId
      ? ({
          chatboxId,
          clusterId,
          // `undefined` means "any outcome"; `null` means "no outcome
          // recorded". They are different cells, so the distinction has to
          // survive serialization rather than being collapsed here.
          ...(outcome === undefined ? {} : { outcome }),
          ...(filters ? { filters: toServerFilters(filters) } : {}),
          limit,
          ...(before === undefined ? {} : { before }),
        } as any)
      : "skip";

  const result = useQuery(
    "chatSessions:listSessionsByGoalOutcome" as any,
    args,
  ) as GoalOutcomeDrilldown | undefined;

  return {
    drilldown: result,
    isLoading: enabled && !!chatboxId && !!clusterId && result === undefined,
  };
}
