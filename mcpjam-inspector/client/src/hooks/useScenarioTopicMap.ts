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
  scenarioId?: string;
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
    /** Swarm wave filter. Absent on scenario snapshots. */
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
  | { kind: "scenario"; scenarioId: string }
  | { kind: "swarm"; projectId: string };

/**
 * Fetch topic-map metadata + blob for a scenario or swarm insights scope.
 */
export function useTopicMap({
  scope,
  enabled = true,
}: {
  scope: TopicMapScope | null;
  enabled?: boolean;
}) {
  const scenarioArgs =
    enabled && scope?.kind === "scenario"
      ? ({ scenarioId: scope.scenarioId } as any)
      : "skip";
  const swarmArgs =
    enabled && scope?.kind === "swarm"
      ? ({ projectId: scope.projectId } as any)
      : "skip";

  const scenarioMetadata = useQuery(
    "chatSessions:getTopicMapSnapshot" as any,
    scenarioArgs,
  ) as TopicMapQueryResult | undefined;
  const swarmMetadata = useQuery(
    "chatSessions:getSwarmTopicMapSnapshot" as any,
    swarmArgs,
  ) as TopicMapQueryResult | undefined;

  const metadata =
    scope?.kind === "swarm" ? swarmMetadata : scenarioMetadata;

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
    // Only wait for a blob fetch that actually started. A done run with
    // `topicMapBlobUrl: null` (legacy swarm rebuilds) must not look like
    // loading forever — that blocks the empty/CTA branch.
    isLoading:
      enabled &&
      (metadata === undefined ||
        snapshotLoading ||
        (metadata?.snapshot?.topicMapBlobUrl != null &&
          snapshot == null &&
          !snapshotError)),
  };
}

/** Scenario-only convenience wrapper around `useTopicMap`. */
export function useScenarioTopicMap({
  scenarioId,
  enabled = true,
}: {
  scenarioId: string | null;
  enabled?: boolean;
}) {
  const scope = useMemo<TopicMapScope | null>(
    () => (scenarioId ? { kind: "scenario", scenarioId } : null),
    [scenarioId],
  );
  return useTopicMap({ scope, enabled });
}

/**
 * Build a topic-map scope from an insights scope (drops journeyRunIds).
 *
 * `null` for a benchmark run, and that is a real answer rather than a gap: a
 * neighbour graph over one exam's repetitions draws "these two runs of the
 * same case are similar" and nothing else, so the backend builds no map for
 * one. Falling through to the swarm arm would query with
 * `projectId: undefined` and hand back some other cohort's map.
 */
export function topicMapScopeFromInsights(
  scope: InsightsScope | null,
): TopicMapScope | null {
  if (!scope) return null;
  switch (scope.kind) {
    case "scenario":
      return { kind: "scenario", scenarioId: scope.scenarioId };
    case "swarm":
      return { kind: "swarm", projectId: scope.projectId };
    case "benchmark":
      return null;
  }
}
