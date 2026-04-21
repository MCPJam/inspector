import { startTransition, useEffect, useState } from "react";
import { useQuery } from "convex/react";
import type { ClusterRunState } from "@/hooks/useUsageInsights";

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
  chatboxId: string;
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
    semanticPreview: string;
    messageCount: number;
    startedAt: number;
    lastActivityAt: number;
    modelId?: string;
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

export function useChatboxTopicMap({
  chatboxId,
  enabled = true,
}: {
  chatboxId: string | null;
  enabled?: boolean;
}) {
  const metadata = useQuery(
    "chatSessions:getTopicMapSnapshot" as any,
    enabled && chatboxId ? ({ chatboxId } as any) : "skip",
  ) as TopicMapQueryResult | undefined;
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
      (metadata === undefined || snapshotLoading || (metadata?.snapshot != null && snapshot == null && !snapshotError)),
  };
}
