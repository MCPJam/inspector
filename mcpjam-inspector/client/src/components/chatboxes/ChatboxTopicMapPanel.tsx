import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import { format, formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  Filter,
  Info,
  LoaderCircle,
  Network,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@mcpjam/design-system/tabs";
import { SearchInput } from "@/components/ui/search-input";
import {
  chipKey,
  type UsageFilterChip,
  type UsageFilterState,
} from "@/hooks/chatbox-usage-filters";
import { useChatboxTopicMap } from "@/hooks/useChatboxTopicMap";
import type { ClusterRunState } from "@/hooks/useUsageInsights";
import { cn } from "@/lib/utils";

const CLUSTER_COLORS = [
  "#f87171",
  "#fbbf24",
  "#4ade80",
  "#60a5fa",
  "#c084fc",
  "#fb7185",
  "#34d399",
  "#38bdf8",
  "#fde047",
  "#a3e635",
  "#f472b6",
  "#2dd4bf",
];
const GRAPH_SPREAD = 1800;
const GRAPH_PADDING = 96;
const GRAPH_VIEWPORT_WIDTH = 1600;
const GRAPH_VIEWPORT_HEIGHT = 1000;

type SidebarTab = "info" | "filters" | "communities";

type GraphNode = {
  id: string;
  clusterId?: string;
  clusterLabel?: string;
  semanticPreview: string;
  messageCount: number;
  startedAt: number;
  lastActivityAt: number;
  modelId?: string;
  degree: number;
  x: number;
  y: number;
  fx: number;
  fy: number;
  color: string;
  radius: number;
  isDimmed: boolean;
  isSearchMatch: boolean;
  isSelected: boolean;
};

type GraphLink = {
  source: string;
  target: string;
  score: number;
  isDimmed: boolean;
  isSelected: boolean;
};

type ProjectedNode = GraphNode & {
  screenX: number;
  screenY: number;
  screenRadius: number;
};

type ProjectedLink = GraphLink & {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
};

interface ChatboxTopicMapPanelProps {
  chatboxId: string;
  filter: UsageFilterState;
  onToggleChip: (chip: UsageFilterChip) => void;
  onClearChip: (key: string) => void;
  onRebuild: () => void;
  rebuildBusy?: boolean;
}

function rebuildButtonLabel(run: ClusterRunState | null): string {
  if (!run) return "Rebuild topic map";
  if (run.isStale) return "Rebuild topic map";
  switch (run.status) {
    case "queued":
      return "Queued…";
    case "running":
      return "Refreshing…";
    case "failed":
      return "Retry rebuild";
    default:
      return "Rebuild topic map";
  }
}

function rebuildDisabled(run: ClusterRunState | null): boolean {
  if (!run) return false;
  if (run.isStale) return false;
  return run.status === "queued" || run.status === "running";
}

function formatRunTone(run: ClusterRunState | null): string {
  if (!run) return "bg-white/10 text-slate-200";
  if (run.status === "failed") return "bg-rose-500/15 text-rose-200";
  if (run.status === "running" || run.status === "queued") {
    return "bg-amber-400/15 text-amber-100";
  }
  return "bg-emerald-400/15 text-emerald-100";
}

function colorForCluster(clusterId: string | undefined, fallbackIndex: number) {
  if (!clusterId) return "#94a3b8";
  return CLUSTER_COLORS[fallbackIndex % CLUSTER_COLORS.length];
}

function matchesSearch(
  query: string,
  node: {
    sessionId: string;
    clusterLabel?: string;
    semanticPreview: string;
    modelId?: string;
  },
) {
  if (!query) return true;
  const haystack = [
    node.sessionId,
    node.clusterLabel ?? "",
    node.semanticPreview,
    node.modelId ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

export function ChatboxTopicMapPanel({
  chatboxId,
  filter,
  onToggleChip,
  onClearChip,
  onRebuild,
  rebuildBusy,
}: ChatboxTopicMapPanelProps) {
  const { latestRun, snapshot, snapshotMetadata, snapshotError, isLoading } =
    useChatboxTopicMap({
      chatboxId,
      enabled: true,
    });
  const [activeTab, setActiveTab] = useState<SidebarTab>("info");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearch = useDeferredValue(searchQuery.trim().toLowerCase());

  const activeClusterIds = useMemo(
    () =>
      new Set(
        filter.chips.flatMap((chip) =>
          chip.kind === "cluster" ? [chip.clusterId] : [],
        ),
      ),
    [filter.chips],
  );

  const clusterColorIndex = useMemo(
    () =>
      new Map(
        (snapshot?.clusters ?? []).map((cluster) => [
          cluster.clusterId,
          cluster.colorIndex,
        ]),
      ),
    [snapshot?.clusters],
  );

  const graphData = useMemo(() => {
    if (!snapshot) return null;
    const nodes: GraphNode[] = snapshot.nodes.map((node) => {
      const clusterMatch =
        activeClusterIds.size === 0 ||
        (node.clusterId ? activeClusterIds.has(node.clusterId) : false);
      const searchMatch = matchesSearch(deferredSearch, {
        sessionId: node.sessionId,
        clusterLabel: node.clusterLabel,
        semanticPreview: node.semanticPreview,
        modelId: node.modelId,
      });
      const color = colorForCluster(
        node.clusterId,
        clusterColorIndex.get(node.clusterId ?? "") ?? 0,
      );
      const radius = Math.max(
        2,
        Math.min(7, 2 + Math.log1p(node.degree + node.messageCount) * 0.9),
      );
      return {
        id: node.sessionId,
        clusterId: node.clusterId,
        clusterLabel: node.clusterLabel,
        semanticPreview: node.semanticPreview,
        messageCount: node.messageCount,
        startedAt: node.startedAt,
        lastActivityAt: node.lastActivityAt,
        modelId: node.modelId,
        degree: node.degree,
        x: node.x * GRAPH_SPREAD,
        y: node.y * GRAPH_SPREAD,
        fx: node.x * GRAPH_SPREAD,
        fy: node.y * GRAPH_SPREAD,
        color,
        radius,
        isDimmed: !clusterMatch || !searchMatch,
        isSearchMatch: searchMatch,
        isSelected: node.sessionId === selectedNodeId,
      };
    });

    const dimmedNodes = new Map(nodes.map((node) => [node.id, node.isDimmed]));
    const selectedEdges = new Set<string>();
    if (selectedNodeId) {
      snapshot.edges.forEach((edge) => {
        if (edge.source === selectedNodeId || edge.target === selectedNodeId) {
          selectedEdges.add(`${edge.source}:${edge.target}`);
        }
      });
    }
    const links: GraphLink[] = snapshot.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      score: edge.score,
      isDimmed:
        (dimmedNodes.get(edge.source) ?? false) ||
        (dimmedNodes.get(edge.target) ?? false),
      isSelected: selectedEdges.has(`${edge.source}:${edge.target}`),
    }));

    return { nodes, links };
  }, [activeClusterIds, clusterColorIndex, deferredSearch, selectedNodeId, snapshot]);

  const nodeById = useMemo(
    () =>
      new Map(
        (graphData?.nodes ?? []).map((node) => [node.id, node]),
      ),
    [graphData?.nodes],
  );

  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) ?? null : null;

  const selectedNeighbors = useMemo(() => {
    if (!selectedNodeId || !graphData) return [];
    return graphData.links
      .filter(
        (edge) => edge.source === selectedNodeId || edge.target === selectedNodeId,
      )
      .sort((left, right) => right.score - left.score)
      .map((edge) => {
        const neighborId =
          edge.source === selectedNodeId ? edge.target : edge.source;
        const node = nodeById.get(neighborId);
        return node
          ? {
              id: neighborId,
              score: edge.score,
              clusterLabel: node.clusterLabel,
              semanticPreview: node.semanticPreview,
              color: node.color,
            }
          : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }, [graphData, nodeById, selectedNodeId]);

  const searchMatches = useMemo(() => {
    if (!graphData || !deferredSearch) return [];
    return graphData.nodes
      .filter((node) => node.isSearchMatch)
      .slice(0, 12);
  }, [deferredSearch, graphData]);

  const communities = useMemo(
    () =>
      [...(snapshot?.clusters ?? [])].sort(
        (left, right) => right.memberCount - left.memberCount,
      ),
    [snapshot?.clusters],
  );

  useEffect(() => {
    if (!snapshot) {
      setSelectedNodeId(null);
      return;
    }
    if (selectedNodeId && snapshot.nodes.some((node) => node.sessionId === selectedNodeId)) {
      return;
    }
    setSelectedNodeId(snapshot.nodes[0]?.sessionId ?? null);
  }, [selectedNodeId, snapshot]);

  const projectedGraph = useMemo(() => {
    if (!graphData) {
      return null;
    }

    const nodes = graphData.nodes;
    const xs = nodes.map((node) => node.fx ?? node.x ?? 0);
    const ys = nodes.map((node) => node.fy ?? node.y ?? 0);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const availableWidth = Math.max(1, GRAPH_VIEWPORT_WIDTH - GRAPH_PADDING * 2);
    const availableHeight = Math.max(1, GRAPH_VIEWPORT_HEIGHT - GRAPH_PADDING * 2);
    const scale = Math.max(
      0.05,
      Math.min(availableWidth / spanX, availableHeight / spanY),
    );
    const offsetX = (GRAPH_VIEWPORT_WIDTH - spanX * scale) / 2;
    const offsetY = (GRAPH_VIEWPORT_HEIGHT - spanY * scale) / 2;

    const projectedNodes = nodes.map((node) => {
      const graphX = node.fx ?? node.x ?? 0;
      const graphY = node.fy ?? node.y ?? 0;
      return {
        ...node,
        screenX: (graphX - minX) * scale + offsetX,
        screenY: (graphY - minY) * scale + offsetY,
        screenRadius: Math.max(4.5, node.radius * 1.5),
      };
    });
    const projectedById = new Map(
      projectedNodes.map((node) => [node.id, node]),
    );
    const projectedLinks = graphData.links
      .map((link) => {
        const source = projectedById.get(link.source);
        const target = projectedById.get(link.target);
        if (!source || !target) return null;
        return {
          ...link,
          sourceX: source.screenX,
          sourceY: source.screenY,
          targetX: target.screenX,
          targetY: target.screenY,
        };
      })
      .filter((link): link is ProjectedLink => link !== null);

    return {
      nodes: projectedNodes,
      links: projectedLinks,
    };
  }, [graphData]);

  const activeClusterChips = filter.chips.filter(
    (chip): chip is Extract<UsageFilterChip, { kind: "cluster" }> =>
      chip.kind === "cluster",
  );

  const runCopy =
    latestRun?.status === "running"
      ? "Updating historical topic map"
      : latestRun?.status === "queued"
        ? "Queued for rebuild"
        : latestRun?.status === "failed"
          ? "Last rebuild failed"
          : snapshot
            ? `${snapshot.stats.mappedSessionCount.toLocaleString()} mapped sessions`
            : "No topic map yet";

  if (!snapshot && (isLoading || latestRun?.status === "running" || latestRun?.status === "queued")) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-[#070917] text-slate-100">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <LoaderCircle className="h-8 w-8 animate-spin text-cyan-200" />
          <div>
            <p className="text-sm font-medium">Building the historical topic map</p>
            <p className="mt-1 text-xs text-slate-300/70">
              Sessions are being summarized, clustered, and laid out for the graph.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-[#070917] text-slate-100">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          {latestRun?.status === "failed" ? (
            <AlertTriangle className="h-8 w-8 text-rose-300" />
          ) : (
            <Network className="h-8 w-8 text-slate-400" />
          )}
          <div>
            <p className="text-sm font-medium">
              {latestRun?.status === "failed"
                ? "Topic map rebuild failed"
                : "No topic map snapshot yet"}
            </p>
            <p className="mt-1 text-xs text-slate-300/70">
              {snapshotError ??
                latestRun?.errorMessage ??
                "Run a rebuild to summarize and cluster historical sessions."}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="border-white/15 bg-white/5 text-slate-100 hover:bg-white/10"
            disabled={rebuildDisabled(latestRun) || rebuildBusy}
            onClick={onRebuild}
          >
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            {rebuildButtonLabel(latestRun)}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-[#070917] text-slate-100">
      <div className="relative min-w-0 flex-1 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(34,197,94,0.14),_transparent_26%),radial-gradient(circle_at_bottom_right,_rgba(96,165,250,0.12),_transparent_30%),linear-gradient(180deg,_rgba(15,23,42,0.06),_rgba(2,6,23,0.18))]" />

        <div className="absolute left-4 right-4 top-4 z-10 flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-white/8 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-200/80">
                Historical Topic Map
              </span>
              <span
                className={cn(
                  "rounded-full px-2.5 py-1 text-[11px] font-medium",
                  formatRunTone(latestRun),
                )}
              >
                {runCopy}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-300/75">
              <span>{snapshot.stats.nodeCount.toLocaleString()} visible nodes</span>
              <span>•</span>
              <span>{snapshot.stats.edgeCount.toLocaleString()} edges</span>
              <span>•</span>
              <span>{snapshot.stats.clusterCount} communities</span>
              {snapshot.stats.unmappedSessionCount > 0 ? (
                <>
                  <span>•</span>
                  <span>
                    {snapshot.stats.unmappedSessionCount.toLocaleString()} unmapped
                  </span>
                </>
              ) : null}
            </div>
            {snapshot.isSampled ? (
              <div className="max-w-xl rounded-2xl border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-[11px] text-amber-100/90">
                Showing a stable 10,000-session sample of{" "}
                {snapshot.stats.mappedSessionCount.toLocaleString()} mapped
                sessions for this chatbox.
              </div>
            ) : null}
          </div>

          <Button
            type="button"
            variant="outline"
            className="border-white/15 bg-white/5 text-slate-100 hover:bg-white/10"
            disabled={rebuildDisabled(latestRun) || rebuildBusy}
            onClick={onRebuild}
          >
            <RefreshCw
              className={cn(
                "mr-2 h-3.5 w-3.5",
                latestRun?.status === "running" && !latestRun.isStale
                  ? "animate-spin"
                  : "",
              )}
            />
            {rebuildButtonLabel(latestRun)}
          </Button>
        </div>

        <div className="h-full w-full">
          {projectedGraph ? (
            <svg
              width="100%"
              height="100%"
              viewBox={`0 0 ${GRAPH_VIEWPORT_WIDTH} ${GRAPH_VIEWPORT_HEIGHT}`}
              preserveAspectRatio="xMidYMid meet"
              className="block h-full w-full"
              role="img"
              aria-label="Historical session topic map"
            >
              <g>
                {projectedGraph.links.map((link) => (
                  <line
                    key={`${link.source}:${link.target}`}
                    x1={link.sourceX}
                    y1={link.sourceY}
                    x2={link.targetX}
                    y2={link.targetY}
                    stroke={
                      link.isSelected
                        ? "rgba(248,250,252,0.6)"
                        : link.isDimmed
                          ? "rgba(148,163,184,0.08)"
                          : "rgba(148,163,184,0.24)"
                    }
                    strokeWidth={link.isSelected ? 2 : link.isDimmed ? 0.75 : 1.2}
                    strokeLinecap="round"
                  />
                ))}
              </g>
              <g>
                {projectedGraph.nodes.map((node) => (
                  <g
                    key={node.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Topic map node ${node.clusterLabel ?? node.id}`}
                    onClick={() => {
                      setSelectedNodeId(node.id);
                      setActiveTab("info");
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedNodeId(node.id);
                        setActiveTab("info");
                      }
                    }}
                    className="cursor-pointer outline-none"
                  >
                    {node.isSearchMatch && deferredSearch ? (
                      <circle
                        cx={node.screenX}
                        cy={node.screenY}
                        r={node.screenRadius + 5}
                        fill="transparent"
                        stroke="rgba(248,250,252,0.72)"
                        strokeWidth="2"
                      />
                    ) : null}
                    <circle
                      cx={node.screenX}
                      cy={node.screenY}
                      r={node.screenRadius + (node.isSelected ? 3 : 0)}
                      fill={node.isSelected ? "rgba(255,255,255,0.14)" : "transparent"}
                    />
                    <circle
                      cx={node.screenX}
                      cy={node.screenY}
                      r={node.screenRadius}
                      fill={node.isDimmed ? "rgba(148,163,184,0.26)" : node.color}
                      stroke={node.isSelected ? "#ffffff" : "rgba(15,23,42,0.55)"}
                      strokeWidth={node.isSelected ? 2.5 : 1}
                    />
                  </g>
                ))}
              </g>
            </svg>
          ) : null}
        </div>
      </div>

      <aside className="flex w-[360px] shrink-0 flex-col border-l border-white/10 bg-[#0d1120]">
        <div className="border-b border-white/10 p-4">
          <SearchInput
            value={searchQuery}
            onValueChange={(value) => startTransition(() => setSearchQuery(value))}
            placeholder="Search nodes..."
            className="text-slate-100"
          />
        </div>

        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as SidebarTab)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="grid grid-cols-3 rounded-none border-b border-white/10 bg-transparent p-0">
            <TabsTrigger
              value="info"
              className="rounded-none border-r border-white/10 data-[state=active]:bg-white/10"
            >
              Info
            </TabsTrigger>
            <TabsTrigger
              value="filters"
              className="rounded-none border-r border-white/10 data-[state=active]:bg-white/10"
            >
              Filters
            </TabsTrigger>
            <TabsTrigger
              value="communities"
              className="rounded-none data-[state=active]:bg-white/10"
            >
              Communities
            </TabsTrigger>
          </TabsList>

          <TabsContent value="info" className="min-h-0 flex-1 data-[state=inactive]:hidden">
            <ScrollArea className="h-full">
              <div className="space-y-5 p-4">
                {selectedNode ? (
                  <>
                    <section className="space-y-3">
                      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-300/70">
                        <Info className="h-3.5 w-3.5" />
                        Node Info
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                        <p className="break-all text-sm font-semibold text-slate-50">
                          {selectedNode.id}
                        </p>
                        <dl className="mt-3 space-y-2 text-xs text-slate-300/80">
                          <div className="flex items-start justify-between gap-3">
                            <dt>Community</dt>
                            <dd className="text-right text-slate-100">
                              {selectedNode.clusterLabel ?? "Unclustered"}
                            </dd>
                          </div>
                          <div className="flex items-start justify-between gap-3">
                            <dt>Started</dt>
                            <dd className="text-right text-slate-100">
                              {format(new Date(selectedNode.startedAt), "yyyy-MM-dd")}
                            </dd>
                          </div>
                          <div className="flex items-start justify-between gap-3">
                            <dt>Messages</dt>
                            <dd className="text-right text-slate-100">
                              {selectedNode.messageCount}
                            </dd>
                          </div>
                          <div className="flex items-start justify-between gap-3">
                            <dt>Degree</dt>
                            <dd className="text-right text-slate-100">
                              {selectedNode.degree}
                            </dd>
                          </div>
                          {selectedNode.modelId ? (
                            <div className="flex items-start justify-between gap-3">
                              <dt>Model</dt>
                              <dd className="max-w-[180px] text-right font-mono text-slate-100">
                                {selectedNode.modelId}
                              </dd>
                            </div>
                          ) : null}
                        </dl>
                      </div>
                    </section>

                    <section className="space-y-3">
                      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-300/70">
                        <Sparkles className="h-3.5 w-3.5" />
                        Semantic Preview
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm leading-6 text-slate-100/90">
                        {selectedNode.semanticPreview}
                      </div>
                    </section>

                    <section className="space-y-3">
                      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-300/70">
                        <Network className="h-3.5 w-3.5" />
                        Neighbors ({selectedNeighbors.length})
                      </div>
                      <div className="space-y-2">
                        {selectedNeighbors.length > 0 ? (
                          selectedNeighbors.map((neighbor) => (
                            <button
                              key={neighbor.id}
                              type="button"
                              onClick={() => setSelectedNodeId(neighbor.id)}
                              className="w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-left transition hover:bg-white/10"
                            >
                              <div className="flex items-center gap-2">
                                <span
                                  className="h-2.5 w-1 rounded-full"
                                  style={{ backgroundColor: neighbor.color }}
                                />
                                <span className="truncate text-xs font-medium text-slate-100">
                                  {neighbor.clusterLabel ?? "Unclustered"}
                                </span>
                                <span className="ml-auto text-[11px] text-slate-300/70">
                                  {(neighbor.score * 100).toFixed(0)}%
                                </span>
                              </div>
                              <p className="mt-1 line-clamp-2 text-xs text-slate-300/80">
                                {neighbor.semanticPreview}
                              </p>
                            </button>
                          ))
                        ) : (
                          <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] px-3 py-4 text-xs text-slate-300/70">
                            No reciprocal neighbors survived the graph pruning for
                            this node.
                          </div>
                        )}
                      </div>
                    </section>
                  </>
                ) : (
                  <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] p-4 text-sm text-slate-300/70">
                    Select a node to inspect its summary, community, and nearest
                    neighbors.
                  </div>
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="filters" className="min-h-0 flex-1 data-[state=inactive]:hidden">
            <ScrollArea className="h-full">
              <div className="space-y-5 p-4">
                <section className="space-y-3">
                  <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-300/70">
                    <Filter className="h-3.5 w-3.5" />
                    Active Community Filters
                  </div>
                  {activeClusterChips.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {activeClusterChips.map((chip) => (
                        <button
                          key={chipKey(chip)}
                          type="button"
                          onClick={() => onClearChip(chipKey(chip))}
                          className="rounded-full border border-white/10 bg-white/8 px-3 py-1 text-xs text-slate-100 transition hover:bg-white/12"
                        >
                          {chip.label ?? chip.clusterId}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] px-3 py-4 text-xs text-slate-300/70">
                      No community filters are active. Pick a community from the
                      Communities tab to isolate it in the graph.
                    </div>
                  )}
                </section>

                <section className="space-y-3">
                  <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-300/70">
                    <Sparkles className="h-3.5 w-3.5" />
                    Search Results
                  </div>
                  {deferredSearch ? (
                    searchMatches.length > 0 ? (
                      <div className="space-y-2">
                        {searchMatches.map((node) => (
                          <button
                            key={node.id}
                            type="button"
                            onClick={() => {
                              setSelectedNodeId(node.id);
                              setActiveTab("info");
                            }}
                            className="w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-left transition hover:bg-white/10"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <span className="truncate text-xs font-medium text-slate-100">
                                {node.clusterLabel ?? "Unclustered"}
                              </span>
                              <span className="text-[11px] text-slate-300/70">
                                {formatDistanceToNow(new Date(node.lastActivityAt), {
                                  addSuffix: true,
                                })}
                              </span>
                            </div>
                            <p className="mt-1 line-clamp-2 text-xs text-slate-300/80">
                              {node.semanticPreview}
                            </p>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] px-3 py-4 text-xs text-slate-300/70">
                        No nodes matched “{deferredSearch}”.
                      </div>
                    )
                  ) : (
                    <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] px-3 py-4 text-xs text-slate-300/70">
                      Search by community label, semantic preview, session ID, or
                      model.
                    </div>
                  )}
                </section>
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="communities" className="min-h-0 flex-1 data-[state=inactive]:hidden">
            <ScrollArea className="h-full">
              <div className="space-y-3 p-4">
                {communities.map((community) => {
                  const isActive = activeClusterIds.has(community.clusterId);
                  return (
                    <button
                      key={community.clusterId}
                      type="button"
                      onClick={() =>
                        onToggleChip({
                          kind: "cluster",
                          clusterId: community.clusterId,
                          label: community.label,
                        })
                      }
                      className={cn(
                        "w-full rounded-2xl border px-3 py-3 text-left transition",
                        isActive
                          ? "border-cyan-300/50 bg-cyan-300/10"
                          : "border-white/10 bg-white/5 hover:bg-white/10",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-slate-50">
                            {community.label}
                          </p>
                          <p className="mt-1 text-xs text-slate-300/75">
                            {community.summary}
                          </p>
                        </div>
                        <span className="rounded-full bg-white/8 px-2 py-1 text-[11px] text-slate-100">
                          {community.memberCount}
                        </span>
                      </div>
                      {community.keywords.length > 0 ? (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {community.keywords.map((keyword) => (
                            <span
                              key={keyword}
                              className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-slate-300/80"
                            >
                              {keyword}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </aside>
    </div>
  );
}
