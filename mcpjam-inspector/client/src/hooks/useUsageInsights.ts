import { useMutation, useQuery } from "convex/react";
import type {
  UsageFilterState,
  UsageFilterChip,
} from "@/hooks/chatbox-usage-filters";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";

export type InsightsSourceType = "chatbox" | "serverShare";

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
  isStale: boolean;
};

export type UsageBreakdown = {
  themes: Array<{ clusterId: string; label: string; count: number }>;
  geography: BreakdownBucket[];
  userBreakdown: FeedbackBucketCount[];
  deviceBreakdown: BreakdownBucket[];
  languageBreakdown: BreakdownBucket[];
  modelBreakdown: BreakdownBucket[];
  totalSessions: number;
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
  sourceType,
  sourceId,
  filters,
}: {
  sourceType: InsightsSourceType;
  sourceId: string | null;
  filters: UsageFilterState;
}) {
  // v1 only wires chatbox sources. ServerShare will reuse this hook by
  // swapping the underlying queries once the backend parity lands.
  const chatboxArgs =
    sourceType === "chatbox" && sourceId
      ? ({
          chatboxId: sourceId,
          limit: 100,
          includeInternal: true,
          filters: toServerFilters(filters),
        } as any)
      : "skip";

  const breakdownArgs =
    sourceType === "chatbox" && sourceId
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
