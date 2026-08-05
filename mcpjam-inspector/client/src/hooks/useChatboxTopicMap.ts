import { startTransition, useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import type { ClusterRunState, InsightsScope } from "@/hooks/useUsageInsights";

export type TopicMapCluster = {
  _id: string;
  label: string;
  summary: string;
  keywords: string[];
  memberCount: number;
  createdAt: number;
};

export type TopicMapSnapshotMetadata = {
  runId: string;
  topicMapBlobUrl: string | null;
  topicMapVersion: number;
  edgeCount: number;
  sampleNodeCount: number;
  unmappedSessionCount: number;
  isSampled: boolean;
  sessionCount: number;
  clusterCount: number;
};

export type TopicMapSnapshot = {
  version: number;
  chatboxId?: string;
  projectId?: string;
  runId: string;
  generatedAt: number;
  isSampled: boolean;
  stats: {
    nodeCount: number;
    edgeCount: number;
    clusterCount: number;
    mappedSessionCount: number;
    unmappedSessionCount: number;
  };
  clusters: Array<{
    clusterId: string;
    label: string;
    summary: string;
    keywords: string[];
    memberCount: number;
    colorIndex: number;
  }>;
  nodes: Array<{
    sessionId: string;
    x: number;
    y: number;
    degree: number;
    clusterId?: string;
    clusterLabel?: string;
    semanticTitle?: string;
    semanticPreview: string;
    messageCount: number;
    startedAt: number;
    lastActivityAt: number;
    modelId?: string;
    /** Swarm wave filter. Absent on chatbox snapshots. */
    journeyRunId?: string;
    /**
     * Present from snapshot `version` 2 onward. Absent on older blobs AND on
     * sessions whose signals never extracted — color-by-outcome must render
     * both as "unknown" rather than substituting a bucket.
     */
    outcome?: "completed" | "partial" | "unresolved" | "errored" | "unclear";
  }>;
  edges: Array<{
    source: string;
    target: string;
    score: number;
  }>;
};

type TopicMapQueryResult = {
  latestRun: ClusterRunState | null;
  snapshot: TopicMapSnapshotMetadata | null;
  clusters: TopicMapCluster[];
} | null;

export type TopicMapScope =
  | { kind: "chatbox"; chatboxId: string }
  | { kind: "swarm"; projectId: string };

/**
 * Fetch topic-map metadata + blob for a chatbox or swarm insights scope.
 */
export function useTopicMap({
  scope,
  enabled = true,
}: {
  scope: TopicMapScope | null;
  enabled?: boolean;
}) {
  const chatboxArgs =
    enabled && scope?.kind === "chatbox"
      ? ({ chatboxId: scope.chatboxId } as any)
      : "skip";
  const swarmArgs =
    enabled && scope?.kind === "swarm"
      ? ({ projectId: scope.projectId } as any)
      : "skip";

  const chatboxMetadata = useQuery(
    "chatSessions:getTopicMapSnapshot" as any,
    chatboxArgs,
  ) as TopicMapQueryResult | undefined;
  const swarmMetadata = useQuery(
    "chatSessions:getSwarmTopicMapSnapshot" as any,
    swarmArgs,
  ) as TopicMapQueryResult | undefined;

  const metadata =
    scope?.kind === "swarm" ? swarmMetadata : chatboxMetadata;

  const [snapshot, setSnapshot] = useState<TopicMapSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null);
      setSnapshotError(null);
      setSnapshotLoading(false);
      return;
    }

    const url = metadata?.snapshot?.topicMapBlobUrl ?? null;
    if (!url) {
      setSnapshot(null);
      setSnapshotError(null);
      setSnapshotLoading(false);
      return;
    }

    const controller = new AbortController();
    setSnapshotLoading(true);
    setSnapshotError(null);

    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load topic map (${response.status})`);
        }
        return (await response.json()) as TopicMapSnapshot;
      })
      .then((nextSnapshot) => {
        startTransition(() => {
          setSnapshot(nextSnapshot);
          setSnapshotLoading(false);
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        startTransition(() => {
          setSnapshot(null);
          setSnapshotLoading(false);
          setSnapshotError(
            error instanceof Error
              ? error.message
              : "Failed to load topic map snapshot.",
          );
        });
      });

    return () => {
      controller.abort();
    };
  }, [enabled, metadata?.snapshot?.runId, metadata?.snapshot?.topicMapBlobUrl]);

  return {
    metadata,
    latestRun: metadata?.latestRun ?? null,
    clusters: metadata?.clusters ?? [],
    snapshot,
    snapshotMetadata: metadata?.snapshot ?? null,
    snapshotError,
    isLoading:
      enabled &&
      (metadata === undefined ||
        snapshotLoading ||
        (metadata?.snapshot != null && snapshot == null && !snapshotError)),
  };
}

/** Chatbox-only convenience wrapper around `useTopicMap`. */
export function useChatboxTopicMap({
  chatboxId,
  enabled = true,
}: {
  chatboxId: string | null;
  enabled?: boolean;
}) {
  const scope = useMemo<TopicMapScope | null>(
    () => (chatboxId ? { kind: "chatbox", chatboxId } : null),
    [chatboxId],
  );
  return useTopicMap({ scope, enabled });
}

/** Build a topic-map scope from an insights scope (drops journeyRunIds). */
export function topicMapScopeFromInsights(
  scope: InsightsScope | null,
): TopicMapScope | null {
  if (!scope) return null;
  if (scope.kind === "chatbox") {
    return { kind: "chatbox", chatboxId: scope.chatboxId };
  }
  return { kind: "swarm", projectId: scope.projectId };
}
