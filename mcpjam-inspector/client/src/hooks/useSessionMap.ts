import { useEffect, useMemo, useState, useCallback } from "react";
import { useConvex, useQuery } from "convex/react";
import type {
  InsightsScope,
  InsightsAnalysisSummary,
} from "@/hooks/useUsageInsights";
export type TopicMapSnapshot = {
  version: number;
  analysis: InsightsAnalysisSummary;
  scopeTotals: { mapped: number };
  sampling: {
    limit: number;
    populationScanned: number;
    populationTruncated: boolean;
  };
  scenarioId?: string;
  projectId?: string;
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

export type TopicMapScope = Exclude<InsightsScope, { kind: "benchmark" }>;
/** The reactive subscription carries only a version. Fetch failures keep the last usable graph. */
export function useSessionMap({
  scope,
  enabled = true,
}: {
  scope: TopicMapScope | null;
  enabled?: boolean;
}) {
  const convex = useConvex();
  const scopeKey = JSON.stringify(
    scope?.kind === "swarm"
      ? {
          projectId: scope.projectId,
          journeyRunIds: [...(scope.journeyRunIds ?? [])].sort(),
        }
      : scope
      ? { scenarioId: scope.scenarioId }
      : null,
  );
  const args = useMemo(() => JSON.parse(scopeKey), [scopeKey]);
  const metadata = useQuery(
    "chatSessions:getSessionMapVersion" as any,
    enabled && args ? args : "skip",
  ) as
    | { version: number; nodeCount: number; updatedAt: number | null }
    | undefined;
  const [state, setState] = useState<{
    key: string;
    snapshot: TopicMapSnapshot | null;
    error: string | null;
    loading: boolean;
  }>({ key: scopeKey, snapshot: null, error: null, loading: false });
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);
  useEffect(() => {
    if (!enabled || !args || metadata === undefined) return;
    let cancelled = false;
    setState((old) => ({
      key: scopeKey,
      snapshot: old.key === scopeKey ? old.snapshot : null,
      error: null,
      loading: true,
    }));
    const timer = setTimeout(() => {
      void convex
        .query("chatSessions:getSessionMapNodes" as any, {
          ...args,
          version: metadata.version,
        })
        .then((snapshot: TopicMapSnapshot) => {
          if (!cancelled)
            setState({ key: scopeKey, snapshot, error: null, loading: false });
        })
        .catch((error: unknown) => {
          if (!cancelled)
            setState((old) => ({
              ...old,
              loading: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Could not refresh map",
            }));
        });
    }, 2000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [convex, enabled, args, scopeKey, metadata?.version, retryNonce]);
  const current = state.key === scopeKey;
  return {
    snapshot: current && enabled ? state.snapshot : null,
    snapshotError: current ? state.error : null,
    isLoading:
      enabled &&
      !!scope &&
      (metadata === undefined || !current || state.loading),
    retry,
    scopeKey,
  };
}
