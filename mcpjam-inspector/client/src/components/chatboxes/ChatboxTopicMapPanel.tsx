import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ForceGraph2D from "react-force-graph-2d";
import { format, formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  Filter,
  Info,
  LoaderCircle,
  LocateFixed,
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
  "#fb7185",
  "#f59e0b",
  "#facc15",
  "#4ade80",
  "#2dd4bf",
  "#38bdf8",
  "#60a5fa",
  "#818cf8",
  "#a78bfa",
  "#e879f9",
  "#f472b6",
  "#f97316",
];
const GRAPH_SPREAD = 1400;
const DEFAULT_GRAPH_WIDTH = 1200;
const DEFAULT_GRAPH_HEIGHT = 840;
const GRAPH_PADDING = 96;

type SidebarTab = "info" | "filters" | "communities";

type GraphNode = {
  id: string;
  sessionId: string;
  clusterId?: string;
  clusterLabel?: string;
  semanticPreview: string;
  messageCount: number;
  startedAt: number;
  lastActivityAt: number;
  modelId?: string;
  degree: number;
  seedX: number;
  seedY: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx?: number;
  fy?: number;
  color: string;
  radius: number;
};

type GraphLink = {
  source: string | GraphNode;
  target: string | GraphNode;
  score: number;
};

type GraphData = {
  nodes: GraphNode[];
  links: GraphLink[];
};

type GraphHandle = {
  zoomToFit?: (
    durationMs?: number,
    padding?: number,
    nodeFilter?: (node: GraphNode) => boolean,
  ) => void;
  centerAt?: (x?: number, y?: number, durationMs?: number) => void;
  zoom?: (scale: number, durationMs?: number) => void;
  d3Force?: (forceName: string, forceFn?: unknown) => unknown;
  d3ReheatSimulation?: () => void;
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

function colorForCluster(clusterId: string | undefined, fallbackIndex?: number) {
  if (!clusterId) return "#9aa4ba";
  if (typeof fallbackIndex === "number" && Number.isFinite(fallbackIndex)) {
    return CLUSTER_COLORS[Math.abs(fallbackIndex) % CLUSTER_COLORS.length];
  }
  let hash = 0;
  for (let index = 0; index < clusterId.length; index += 1) {
    hash = (hash * 31 + clusterId.charCodeAt(index)) >>> 0;
  }
  const colorIndex = hash % CLUSTER_COLORS.length;
  return CLUSTER_COLORS[colorIndex];
}

function hexToRgba(hex: string, alpha: number) {
  const normalized = hex.replace("#", "");
  const value =
    normalized.length === 3
      ? normalized
          .split("")
          .map((character) => character + character)
          .join("")
      : normalized;
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
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

function getLinkEndpointId(endpoint: GraphLink["source"] | GraphLink["target"]) {
  if (typeof endpoint === "string") return endpoint;
  return endpoint?.id ?? null;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const nextRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + nextRadius, y);
  ctx.arcTo(x + width, y, x + width, y + height, nextRadius);
  ctx.arcTo(x + width, y + height, x, y + height, nextRadius);
  ctx.arcTo(x, y + height, x, y, nextRadius);
  ctx.arcTo(x, y, x + width, y, nextRadius);
  ctx.closePath();
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({
    width: DEFAULT_GRAPH_WIDTH,
    height: DEFAULT_GRAPH_HEIGHT,
  });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const update = (rect?: DOMRectReadOnly) => {
      const width = Math.max(
        360,
        Math.round(rect?.width ?? element.clientWidth ?? DEFAULT_GRAPH_WIDTH),
      );
      const height = Math.max(
        420,
        Math.round(rect?.height ?? element.clientHeight ?? DEFAULT_GRAPH_HEIGHT),
      );
      setSize((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      );
    };

    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => update(entries[0]?.contentRect));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, size };
}

function linkDistance(score: number) {
  return Math.max(56, 184 - score * 128);
}

function trimPreview(text: string) {
  if (text.length <= 86) return text;
  return `${text.slice(0, 83).trimEnd()}…`;
}

export function ChatboxTopicMapPanel({
  chatboxId,
  filter,
  onToggleChip,
  onClearChip,
  onRebuild,
  rebuildBusy,
}: ChatboxTopicMapPanelProps) {
  const { latestRun, snapshot, snapshotError, isLoading } = useChatboxTopicMap({
    chatboxId,
    enabled: true,
  });
  const [activeTab, setActiveTab] = useState<SidebarTab>("info");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearch = useDeferredValue(searchQuery.trim().toLowerCase());
  const graphRef = useRef<GraphHandle | null>(null);
  const autoFitKeyRef = useRef<string | null>(null);
  const { ref: graphContainerRef, size } = useElementSize<HTMLDivElement>();

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

  const graphData = useMemo<GraphData | null>(() => {
    if (!snapshot) return null;
    const nodes = snapshot.nodes.map((node) => {
      const x = node.x * GRAPH_SPREAD;
      const y = node.y * GRAPH_SPREAD;
      return {
        id: node.sessionId,
        sessionId: node.sessionId,
        clusterId: node.clusterId,
        clusterLabel: node.clusterLabel,
        semanticPreview: node.semanticPreview,
        messageCount: node.messageCount,
        startedAt: node.startedAt,
        lastActivityAt: node.lastActivityAt,
        modelId: node.modelId,
        degree: node.degree,
        seedX: x,
        seedY: y,
        x,
        y,
        vx: 0,
        vy: 0,
        color: colorForCluster(
          node.clusterId,
          node.clusterId != null
            ? clusterColorIndex.get(node.clusterId)
            : undefined,
        ),
        radius: Math.max(
          4.4,
          Math.min(11.8, 4 + Math.log1p(node.degree + node.messageCount) * 1.3),
        ),
      } satisfies GraphNode;
    });
    const links = snapshot.edges.map(
      (edge) =>
        ({
          source: edge.source,
          target: edge.target,
          score: edge.score,
        }) satisfies GraphLink,
    );
    return { nodes, links };
  }, [clusterColorIndex, snapshot]);

  const nodeById = useMemo(
    () => new Map((graphData?.nodes ?? []).map((node) => [node.id, node])),
    [graphData?.nodes],
  );

  const neighborsByNode = useMemo(() => {
    const adjacency = new Map<string, Set<string>>();
    for (const link of graphData?.links ?? []) {
      const sourceId = getLinkEndpointId(link.source);
      const targetId = getLinkEndpointId(link.target);
      if (!sourceId || !targetId) continue;
      if (!adjacency.has(sourceId)) adjacency.set(sourceId, new Set());
      if (!adjacency.has(targetId)) adjacency.set(targetId, new Set());
      adjacency.get(sourceId)!.add(targetId);
      adjacency.get(targetId)!.add(sourceId);
    }
    return adjacency;
  }, [graphData?.links]);

  const searchMatchIds = useMemo(() => {
    if (!graphData || !deferredSearch) return null;
    return new Set(
      graphData.nodes
        .filter((node) =>
          matchesSearch(deferredSearch, {
            sessionId: node.sessionId,
            clusterLabel: node.clusterLabel,
            semanticPreview: node.semanticPreview,
            modelId: node.modelId,
          }),
        )
        .map((node) => node.id),
    );
  }, [deferredSearch, graphData]);

  const focusNodeId = hoveredNodeId;

  const focusedNeighborhood = useMemo(() => {
    if (!focusNodeId) return null;
    const focused = new Set<string>([focusNodeId]);
    const neighbors = neighborsByNode.get(focusNodeId);
    if (neighbors) {
      for (const neighborId of neighbors) focused.add(neighborId);
    }
    return focused;
  }, [focusNodeId, neighborsByNode]);

  const isNodeDimmed = useCallback(
    (node: GraphNode) => {
      const clusterMatch =
        activeClusterIds.size === 0 ||
        (node.clusterId ? activeClusterIds.has(node.clusterId) : false);
      const searchMatch =
        searchMatchIds == null || searchMatchIds.has(node.id);
      const focusMatch =
        focusedNeighborhood == null || focusedNeighborhood.has(node.id);
      return !(clusterMatch && searchMatch && focusMatch);
    },
    [activeClusterIds, focusedNeighborhood, searchMatchIds],
  );

  const searchMatches = useMemo(() => {
    if (!graphData || !searchMatchIds) return [];
    return graphData.nodes
      .filter((node) => searchMatchIds.has(node.id))
      .slice(0, 12);
  }, [graphData, searchMatchIds]);

  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) ?? null : null;

  const selectedNeighbors = useMemo(() => {
    if (!selectedNodeId || !graphData) return [];
    return graphData.links
      .filter((edge) => {
        const sourceId = getLinkEndpointId(edge.source);
        const targetId = getLinkEndpointId(edge.target);
        return sourceId === selectedNodeId || targetId === selectedNodeId;
      })
      .sort((left, right) => right.score - left.score)
      .map((edge) => {
        const sourceId = getLinkEndpointId(edge.source);
        const targetId = getLinkEndpointId(edge.target);
        const neighborId =
          sourceId === selectedNodeId ? targetId : sourceId;
        if (!neighborId) return null;
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

  const communities = useMemo(
    () =>
      [...(snapshot?.clusters ?? [])].sort(
        (left, right) => right.memberCount - left.memberCount,
      ),
    [snapshot?.clusters],
  );

  const activeClusterChips = filter.chips.filter(
    (chip): chip is Extract<UsageFilterChip, { kind: "cluster" }> =>
      chip.kind === "cluster",
  );

  useEffect(() => {
    if (!snapshot) {
      setSelectedNodeId(null);
      return;
    }
    if (
      selectedNodeId &&
      snapshot.nodes.some((node) => node.sessionId === selectedNodeId)
    ) {
      return;
    }
    setSelectedNodeId(snapshot.nodes[0]?.sessionId ?? null);
  }, [selectedNodeId, snapshot]);

  useEffect(() => {
    if (!graphData) return;
    const graph = graphRef.current;
    if (!graph) return;

    const chargeForce = graph.d3Force?.("charge");
    if (chargeForce && typeof (chargeForce as { strength?: unknown }).strength === "function") {
      (chargeForce as {
        strength: (value: (node: GraphNode) => number) => void;
      }).strength((node) => -56 - node.degree * 14 - node.messageCount * 0.9);
    }

    const linkForce = graph.d3Force?.("link");
    if (linkForce && typeof (linkForce as { distance?: unknown }).distance === "function") {
      (
        linkForce as {
          distance: (value: (link: GraphLink) => number) => void;
          strength?: (value: (link: GraphLink) => number) => void;
        }
      ).distance((link) => linkDistance(link.score));
      if (typeof (linkForce as { strength?: unknown }).strength === "function") {
        (
          linkForce as {
            strength: (value: (link: GraphLink) => number) => void;
          }
        ).strength((link) => Math.max(0.06, (link.score - 0.64) * 0.85));
      }
    }

    // Keep the simulation loosely anchored to the stored UMAP positions so the
    // graph feels alive without drifting into an unreadable hairball.
    graph.d3Force?.("seed", (() => {
      let nodes: GraphNode[] = [];
      const force = (alpha: number) => {
        const pull = 0.08 * alpha;
        for (const node of nodes) {
          if (node.fx != null || node.fy != null) continue;
          node.vx += (node.seedX - (node.x ?? 0)) * pull;
          node.vy += (node.seedY - (node.y ?? 0)) * pull;
        }
      };
      force.initialize = (nextNodes: GraphNode[]) => {
        nodes = nextNodes;
      };
      return force;
    })());

    graph.d3ReheatSimulation?.();
  }, [graphData]);

  const fitGraph = useCallback(
    (durationMs = 420) => {
      graphRef.current?.zoomToFit?.(
        durationMs,
        GRAPH_PADDING,
        (node) => !isNodeDimmed(node),
      );
    },
    [isNodeDimmed],
  );

  const focusNode = useCallback(
    (nodeId: string, zoomLevel = 2.1) => {
      const node = nodeById.get(nodeId);
      if (!node) return;
      setSelectedNodeId(nodeId);
      setActiveTab("info");
      graphRef.current?.centerAt?.(node.x, node.y, 560);
      graphRef.current?.zoom?.(zoomLevel, 560);
    },
    [nodeById],
  );

  useEffect(() => {
    if (!snapshot) return;
    const fitKey = `${snapshot.runId}:${size.width}x${size.height}`;
    if (autoFitKeyRef.current === fitKey) return;
    autoFitKeyRef.current = fitKey;
    const timer = window.setTimeout(() => {
      fitGraph(360);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [fitGraph, size.height, size.width, snapshot]);

  const drawNode = useCallback(
    (
      node: GraphNode,
      ctx: CanvasRenderingContext2D,
      globalScale: number,
    ) => {
      const isSelected = node.id === selectedNodeId;
      const isHovered = node.id === hoveredNodeId;
      const isSearchMatch = searchMatchIds?.has(node.id) ?? false;
      const dimmed = isNodeDimmed(node);
      const label = node.clusterLabel ?? node.sessionId;

      ctx.save();
      ctx.globalAlpha = dimmed ? 0.16 : 1;

      if (!dimmed) {
        ctx.shadowColor = node.color;
        ctx.shadowBlur = isSelected ? 32 : isHovered ? 22 : 16;
      }

      ctx.beginPath();
      ctx.fillStyle = isSelected
        ? hexToRgba(node.color, 0.2)
        : isHovered
          ? hexToRgba(node.color, 0.14)
          : "transparent";
      ctx.arc(node.x, node.y, node.radius + (isSelected ? 6 : isHovered ? 4 : 0), 0, 2 * Math.PI);
      ctx.fill();

      if (!dimmed) {
        ctx.beginPath();
        ctx.fillStyle = hexToRgba(
          node.color,
          isSelected ? 0.22 : isHovered ? 0.18 : 0.12,
        );
        ctx.arc(
          node.x,
          node.y,
          node.radius + (isSelected ? 4.8 : isHovered ? 3.6 : 2.6),
          0,
          2 * Math.PI,
        );
        ctx.fill();
      }

      ctx.shadowBlur = 0;

      if (deferredSearch && isSearchMatch) {
        ctx.beginPath();
        ctx.strokeStyle = isSelected
          ? "rgba(255,255,255,0.92)"
          : "rgba(255,255,255,0.55)";
        ctx.lineWidth = 1.4 / globalScale;
        ctx.arc(node.x, node.y, node.radius + 4.2, 0, 2 * Math.PI);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.fillStyle = dimmed ? "rgba(122,138,164,0.26)" : node.color;
      ctx.arc(node.x, node.y, node.radius, 0, 2 * Math.PI);
      ctx.fill();

      ctx.lineWidth = (isSelected ? 2.4 : isHovered ? 1.4 : 0.9) / globalScale;
      ctx.strokeStyle = isSelected ? "#ffffff" : "rgba(6,10,24,0.75)";
      ctx.stroke();

      if (isSelected || isHovered) {
        const titleFontSize = (isSelected ? 13 : 11.5) / globalScale;
        const previewFontSize = 10 / globalScale;
        const titleY = node.y - node.radius - 15 / globalScale;
        const paddingX = 10 / globalScale;
        const paddingY = 8 / globalScale;
        const preview = isSelected ? trimPreview(node.semanticPreview) : null;

        ctx.font = `${isSelected ? 600 : 500} ${titleFontSize}px ui-sans-serif, system-ui, sans-serif`;
        const titleWidth = ctx.measureText(label).width;
        let bubbleWidth = titleWidth + paddingX * 2;
        let bubbleHeight = titleFontSize + paddingY * 2;

        if (preview) {
          ctx.font = `400 ${previewFontSize}px ui-sans-serif, system-ui, sans-serif`;
          bubbleWidth = Math.max(
            bubbleWidth,
            ctx.measureText(preview).width + paddingX * 2,
          );
          bubbleHeight += previewFontSize + 6 / globalScale;
        }

        const bubbleX = node.x + 12 / globalScale;
        const bubbleY = titleY - bubbleHeight / 2;

        ctx.save();
        ctx.globalAlpha = dimmed ? 0.55 : 0.98;
        drawRoundedRect(
          ctx,
          bubbleX,
          bubbleY,
          bubbleWidth,
          bubbleHeight,
          12 / globalScale,
        );
        ctx.fillStyle = "rgba(8,12,26,0.92)";
        ctx.strokeStyle = isSelected
          ? "rgba(255,255,255,0.28)"
          : "rgba(148,163,184,0.18)";
        ctx.lineWidth = 1 / globalScale;
        ctx.fill();
        ctx.stroke();

        ctx.font = `${isSelected ? 600 : 500} ${titleFontSize}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillStyle = "rgba(248,250,252,0.96)";
        ctx.fillText(label, bubbleX + paddingX, bubbleY + paddingY + titleFontSize * 0.82);

        if (preview) {
          ctx.font = `400 ${previewFontSize}px ui-sans-serif, system-ui, sans-serif`;
          ctx.fillStyle = "rgba(203,213,225,0.82)";
          ctx.fillText(
            preview,
            bubbleX + paddingX,
            bubbleY + bubbleHeight - paddingY,
          );
        }
        ctx.restore();
      }

      ctx.restore();
    },
    [
      deferredSearch,
      hoveredNodeId,
      isNodeDimmed,
      searchMatchIds,
      selectedNodeId,
    ],
  );

  const linkColor = useCallback(
    (link: GraphLink) => {
      const sourceId = getLinkEndpointId(link.source);
      const targetId = getLinkEndpointId(link.target);
      if (!sourceId || !targetId) return "rgba(148,163,184,0.14)";
      const sourceNode = nodeById.get(sourceId);
      const targetNode = nodeById.get(targetId);
      const dimmed =
        !sourceNode ||
        !targetNode ||
        isNodeDimmed(sourceNode) ||
        isNodeDimmed(targetNode);
      const touchesSelection =
        selectedNodeId != null &&
        (sourceId === selectedNodeId || targetId === selectedNodeId);
      const touchesHover =
        hoveredNodeId != null &&
        (sourceId === hoveredNodeId || targetId === hoveredNodeId);

      if (touchesSelection) return "rgba(255,255,255,0.42)";
      if (touchesHover && sourceNode) return hexToRgba(sourceNode.color, 0.34);
      if (dimmed) return "rgba(148,163,184,0.06)";
      if (
        sourceNode &&
        targetNode &&
        sourceNode.clusterId &&
        sourceNode.clusterId === targetNode.clusterId
      ) {
        return hexToRgba(sourceNode.color, 0.22);
      }
      return "rgba(148,163,184,0.14)";
    },
    [hoveredNodeId, isNodeDimmed, nodeById, selectedNodeId],
  );

  const linkWidth = useCallback(
    (link: GraphLink) => {
      const sourceId = getLinkEndpointId(link.source);
      const targetId = getLinkEndpointId(link.target);
      const touchesSelection =
        selectedNodeId != null &&
        (sourceId === selectedNodeId || targetId === selectedNodeId);
      const touchesHover =
        hoveredNodeId != null &&
        (sourceId === hoveredNodeId || targetId === hoveredNodeId);
      if (touchesSelection) return 1.9;
      if (touchesHover) return 1.2;
      const sourceNode = sourceId ? nodeById.get(sourceId) : null;
      const targetNode = targetId ? nodeById.get(targetId) : null;
      if (
        !sourceNode ||
        !targetNode ||
        isNodeDimmed(sourceNode) ||
        isNodeDimmed(targetNode)
      ) {
        return 0.45;
      }
      return 0.9;
    },
    [hoveredNodeId, isNodeDimmed, nodeById, selectedNodeId],
  );

  const drawClusterFields = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      if (!graphData) return;

      const clusters = new Map<
        string,
        {
          color: string;
          nodes: GraphNode[];
          sumX: number;
          sumY: number;
        }
      >();

      for (const node of graphData.nodes) {
        if (isNodeDimmed(node)) continue;
        const clusterKey = node.clusterId ?? `unclustered:${node.id}`;
        const existing = clusters.get(clusterKey);
        if (existing) {
          existing.nodes.push(node);
          existing.sumX += node.x ?? node.seedX;
          existing.sumY += node.y ?? node.seedY;
          continue;
        }
        clusters.set(clusterKey, {
          color: node.color,
          nodes: [node],
          sumX: node.x ?? node.seedX,
          sumY: node.y ?? node.seedY,
        });
      }

      for (const cluster of clusters.values()) {
        if (cluster.nodes.length === 0) continue;

        const centerX = cluster.sumX / cluster.nodes.length;
        const centerY = cluster.sumY / cluster.nodes.length;

        let spread = 0;
        for (const node of cluster.nodes) {
          const dx = (node.x ?? node.seedX) - centerX;
          const dy = (node.y ?? node.seedY) - centerY;
          spread = Math.max(spread, Math.hypot(dx, dy) + node.radius * 1.8);
        }

        const radius =
          cluster.nodes.length === 1
            ? Math.max(64, spread + 36)
            : Math.max(120, spread + 92);
        const gradient = ctx.createRadialGradient(
          centerX,
          centerY,
          radius * 0.08,
          centerX,
          centerY,
          radius,
        );
        gradient.addColorStop(
          0,
          hexToRgba(cluster.color, cluster.nodes.length > 1 ? 0.16 : 0.08),
        );
        gradient.addColorStop(
          0.52,
          hexToRgba(cluster.color, cluster.nodes.length > 1 ? 0.08 : 0.04),
        );
        gradient.addColorStop(1, "rgba(0,0,0,0)");

        ctx.save();
        ctx.globalCompositeOperation = "screen";
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
        ctx.fill();

        if (cluster.nodes.length > 1) {
          ctx.beginPath();
          ctx.strokeStyle = hexToRgba(cluster.color, 0.18);
          ctx.lineWidth = 1.1;
          ctx.arc(centerX, centerY, radius * 0.72, 0, 2 * Math.PI);
          ctx.stroke();
        }
        ctx.restore();
      }
    },
    [graphData, isNodeDimmed],
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

  if (
    !snapshot &&
    (isLoading ||
      latestRun?.status === "running" ||
      latestRun?.status === "queued")
  ) {
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
    <div className="flex h-full min-h-0 overflow-hidden bg-[#060914] text-slate-100">
      <div className="relative min-w-0 flex-1 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(32,201,151,0.14),_transparent_24%),radial-gradient(circle_at_bottom_right,_rgba(96,165,250,0.16),_transparent_32%),linear-gradient(180deg,_rgba(10,13,27,0.96),_rgba(4,8,21,1))]" />
        <div
          className="absolute inset-0 opacity-35"
          style={{
            backgroundImage:
              "linear-gradient(rgba(148,163,184,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.05) 1px, transparent 1px)",
            backgroundSize: "40px 40px",
            maskImage:
              "radial-gradient(circle at 50% 45%, rgba(0,0,0,0.95), rgba(0,0,0,0.18) 78%, transparent 100%)",
          }}
        />

        <div className="absolute left-4 right-4 top-4 z-10 flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-white/8 bg-white/6 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.22em] text-slate-200/80">
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
            <p className="text-[11px] text-slate-400/80">
              Drag the canvas to pan, scroll to zoom, click a node to inspect.
            </p>
            {snapshot.isSampled ? (
              <div className="max-w-xl rounded-2xl border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-[11px] text-amber-100/90">
                Showing a stable 10,000-session sample of{" "}
                {snapshot.stats.mappedSessionCount.toLocaleString()} mapped
                sessions for this chatbox.
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="border-white/12 bg-white/[0.04] text-slate-100 hover:bg-white/[0.08]"
              onClick={() => fitGraph()}
            >
              <LocateFixed className="mr-2 h-3.5 w-3.5" />
              Fit view
            </Button>
            <Button
              type="button"
              variant="outline"
              className="border-white/12 bg-white/[0.04] text-slate-100 hover:bg-white/[0.08]"
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
        </div>

        <div ref={graphContainerRef} className="h-full w-full pt-20">
          <ForceGraph2D
            ref={graphRef as never}
            graphData={graphData ?? { nodes: [], links: [] }}
            width={size.width}
            height={size.height}
            backgroundColor="rgba(0,0,0,0)"
            nodeCanvasObjectMode={() => "replace"}
            nodeCanvasObject={drawNode}
            nodeLabel={(node) => {
              const graphNode = node as GraphNode;
              return `${graphNode.clusterLabel ?? graphNode.sessionId}\n${graphNode.semanticPreview}`;
            }}
            linkColor={linkColor}
            linkWidth={linkWidth}
            linkCurvature={(link) => {
              const sourceId = getLinkEndpointId((link as GraphLink).source);
              const targetId = getLinkEndpointId((link as GraphLink).target);
              const emphasized =
                selectedNodeId != null &&
                (sourceId === selectedNodeId || targetId === selectedNodeId);
              return emphasized ? 0.12 : 0.045;
            }}
            autoPauseRedraw={false}
            minZoom={0.35}
            maxZoom={6}
            warmupTicks={30}
            cooldownTicks={150}
            d3AlphaDecay={0.018}
            d3VelocityDecay={0.28}
            enableNodeDrag={false}
            enablePanInteraction
            enableZoomInteraction
            showPointerCursor={(node) => !!node}
            onNodeHover={(node) => {
              setHoveredNodeId((node as GraphNode | null)?.id ?? null);
            }}
            onNodeClick={(node) => {
              focusNode((node as GraphNode).id);
            }}
            onBackgroundClick={() => {
              setHoveredNodeId(null);
            }}
            onRenderFramePre={(ctx) => {
              drawClusterFields(ctx);
              const gradient = ctx.createRadialGradient(
                size.width * 0.52,
                size.height * 0.48,
                size.height * 0.04,
                size.width * 0.52,
                size.height * 0.48,
                size.height * 0.58,
              );
              gradient.addColorStop(0, "rgba(255,255,255,0.02)");
              gradient.addColorStop(1, "rgba(255,255,255,0)");
              ctx.fillStyle = gradient;
              ctx.fillRect(0, 0, size.width, size.height);
            }}
          />
        </div>
      </div>

      <aside className="flex w-[372px] shrink-0 flex-col border-l border-white/10 bg-[#0b1020]/96 backdrop-blur-xl">
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
              className="rounded-none border-r border-white/10 data-[state=active]:bg-white/8"
            >
              Info
            </TabsTrigger>
            <TabsTrigger
              value="filters"
              className="rounded-none border-r border-white/10 data-[state=active]:bg-white/8"
            >
              Filters
            </TabsTrigger>
            <TabsTrigger
              value="communities"
              className="rounded-none data-[state=active]:bg-white/8"
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
                      <div className="rounded-3xl border border-white/10 bg-white/[0.045] p-4 shadow-[0_20px_60px_rgba(4,8,21,0.35)]">
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
                      <div className="rounded-3xl border border-white/10 bg-white/[0.045] p-4 text-sm leading-6 text-slate-100/90 shadow-[0_20px_60px_rgba(4,8,21,0.35)]">
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
                              onClick={() => focusNode(neighbor.id, 2.25)}
                              className="w-full rounded-3xl border border-white/10 bg-white/[0.045] px-3 py-3 text-left transition hover:bg-white/[0.08]"
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
                          <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.03] px-3 py-4 text-xs text-slate-300/70">
                            No reciprocal neighbors survived the graph pruning for
                            this node.
                          </div>
                        )}
                      </div>
                    </section>
                  </>
                ) : (
                  <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.03] p-4 text-sm text-slate-300/70">
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
                          className="rounded-full border border-white/10 bg-white/[0.06] px-3 py-1 text-xs text-slate-100 transition hover:bg-white/[0.1]"
                        >
                          {chip.label ?? chip.clusterId}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.03] px-3 py-4 text-xs text-slate-300/70">
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
                            onClick={() => focusNode(node.id, 2.2)}
                            className="w-full rounded-3xl border border-white/10 bg-white/[0.045] px-3 py-3 text-left transition hover:bg-white/[0.08]"
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
                      <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.03] px-3 py-4 text-xs text-slate-300/70">
                        No nodes matched “{deferredSearch}”.
                      </div>
                    )
                  ) : (
                    <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.03] px-3 py-4 text-xs text-slate-300/70">
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
                  const swatch = colorForCluster(
                    community.clusterId,
                    clusterColorIndex.get(community.clusterId) ?? 0,
                  );
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
                        "w-full rounded-3xl border px-3 py-3 text-left transition",
                        isActive
                          ? "border-cyan-300/40 bg-cyan-300/10"
                          : "border-white/10 bg-white/[0.045] hover:bg-white/[0.08]",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              className="h-2.5 w-2.5 rounded-full"
                              style={{ backgroundColor: swatch }}
                            />
                            <p className="truncate text-sm font-semibold text-slate-50">
                              {community.label}
                            </p>
                          </div>
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
