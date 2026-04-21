import type { RefObject } from "react";
import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ForceGraph2D from "react-force-graph-2d";
import {
  AlertTriangle,
  LoaderCircle,
  LocateFixed,
  Network,
  RefreshCw,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { SearchInput } from "@/components/ui/search-input";
import {
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

/** Dark `.app-theme-scope` fallbacks from `index.css` until the panel ref resolves tokens for canvas. */
const DEFAULT_CANVAS_PALETTE = {
  background: "oklch(0.2679 0.0036 106.6427)",
  foreground: "oklch(0.8074 0.0142 93.0137)",
  mutedForeground: "oklch(0.7713 0.0169 99.0657)",
  border: "oklch(0.3618 0.0101 106.8928)",
  card: "oklch(0.2679 0.0036 106.6427)",
  primary: "oklch(0.6724 0.1308 38.7559)",
} as const;

type TopicMapCanvasPalette = {
  background: string;
  foreground: string;
  mutedForeground: string;
  border: string;
  card: string;
  primary: string;
};

function useTopicMapCanvasPalette(containerRef: RefObject<HTMLElement | null>) {
  const [palette, setPalette] = useState<TopicMapCanvasPalette | null>(null);

  const refresh = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    setPalette({
      background: cs.getPropertyValue("--background").trim(),
      foreground: cs.getPropertyValue("--foreground").trim(),
      mutedForeground: cs.getPropertyValue("--muted-foreground").trim(),
      border: cs.getPropertyValue("--border").trim(),
      card: cs.getPropertyValue("--card").trim(),
      primary: cs.getPropertyValue("--primary").trim(),
    });
  }, [containerRef]);

  useLayoutEffect(() => {
    refresh();
    const el = containerRef.current;
    if (!el || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      refresh();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    const scope = el.closest(".app-theme-scope");
    if (scope) {
      observer.observe(scope, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
    }
    return () => observer.disconnect();
  }, [containerRef, refresh]);

  return palette;
}

type GraphNode = {
  id: string;
  sessionId: string;
  clusterId?: string;
  clusterLabel?: string;
  semanticTitle?: string;
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

function rebuildButtonLabel(
  run: ClusterRunState | null,
  unmappedCount?: number,
): string {
  if (!run) return "Rebuild clusters";
  if (run.isStale) {
    if (unmappedCount && unmappedCount > 0) {
      return `Rebuild clusters \u00b7 ${unmappedCount.toLocaleString()} session${unmappedCount === 1 ? "" : "s"} not shown`;
    }
    return "Rebuild clusters \u00b7 new sessions available";
  }
  switch (run.status) {
    case "queued":
      return "Queued…";
    case "running":
      return "Refreshing…";
    case "failed":
      return "Retry rebuild clusters";
    default:
      if (unmappedCount && unmappedCount > 0) {
        return `Rebuild clusters \u00b7 ${unmappedCount.toLocaleString()} session${unmappedCount === 1 ? "" : "s"} not shown`;
      }
      return "Rebuild clusters";
  }
}

function rebuildDisabled(run: ClusterRunState | null): boolean {
  if (!run) return false;
  if (run.isStale) return false;
  return run.status === "queued" || run.status === "running";
}

function formatRunTone(run: ClusterRunState | null): string {
  if (!run) return "bg-muted text-muted-foreground";
  if (run.status === "failed") return "bg-destructive/15 text-destructive";
  if (run.status === "running" || run.status === "queued") {
    return "bg-pending/15 text-pending-foreground";
  }
  return "bg-success/15 text-success";
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

/** Theme-aware translucent stroke for canvas (oklch-safe in modern browsers). */
function faintLine(color: string, amountPercent: number) {
  const base = color.trim() || DEFAULT_CANVAS_PALETTE.border;
  return `color-mix(in oklch, ${base} ${amountPercent}%, transparent)`;
}

function matchesSearch(
  query: string,
  node: {
    sessionId: string;
    clusterLabel?: string;
    semanticTitle?: string;
    semanticPreview: string;
    modelId?: string;
  },
) {
  if (!query) return true;
  const haystack = [
    node.sessionId,
    node.clusterLabel ?? "",
    node.semanticTitle ?? "",
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

function useElementSize<T extends HTMLElement>(observeKey: unknown) {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({
    width: DEFAULT_GRAPH_WIDTH,
    height: DEFAULT_GRAPH_HEIGHT,
  });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const readSize = () => {
      const rect = element.getBoundingClientRect();
      const w = element.clientWidth || rect.width;
      const h = element.clientHeight || rect.height;
      const width = Math.max(
        360,
        Math.round(w > 0 ? w : DEFAULT_GRAPH_WIDTH),
      );
      const height = Math.max(
        420,
        Math.round(h > 0 ? h : DEFAULT_GRAPH_HEIGHT),
      );
      return { width, height };
    };

    const update = () => {
      const next = readSize();
      setSize((current) =>
        current.width === next.width && current.height === next.height
          ? current
          : next,
      );
    };

    update();

    let raf1 = 0;
    let raf2 = 0;
    const schedulePostLayoutMeasure = () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      raf1 = requestAnimationFrame(() => {
        update();
        raf2 = requestAnimationFrame(update);
      });
    };
    schedulePostLayoutMeasure();

    const onWindowResize = () => {
      update();
    };
    window.addEventListener("resize", onWindowResize);

    if (typeof ResizeObserver === "undefined") {
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
        window.removeEventListener("resize", onWindowResize);
      };
    }

    const observer = new ResizeObserver(() => {
      update();
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.removeEventListener("resize", onWindowResize);
      observer.disconnect();
    };
  }, [observeKey]);

  return { ref, size };
}

function linkDistance(score: number) {
  return Math.max(56, 184 - score * 128);
}

function trimPreview(text: string) {
  if (text.length <= 86) return text;
  return `${text.slice(0, 83).trimEnd()}…`;
}

/**
 * Stopwords removed when deriving a single-word topic label from a session's
 * `semanticPreview`. Covers standard English function words plus the generic
 * chat-context terms that almost every session summary opens with
 * (e.g. "The user wants to...", "User asked about...").
 */
const TOPIC_LABEL_STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "so",
  "if",
  "nor",
  "yet",
  "of",
  "to",
  "for",
  "in",
  "on",
  "at",
  "with",
  "by",
  "from",
  "about",
  "into",
  "onto",
  "over",
  "under",
  "between",
  "through",
  "during",
  "as",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "should",
  "can",
  "could",
  "may",
  "might",
  "must",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "his",
  "its",
  "our",
  "their",
  "this",
  "that",
  "these",
  "those",
  "user",
  "users",
  "assistant",
  "chat",
  "session",
  "please",
  "wants",
  "want",
  "wanted",
  "needs",
  "need",
  "needed",
  "asks",
  "ask",
  "asked",
  "asking",
  "requests",
  "request",
  "requested",
  "requesting",
  "seeks",
  "seek",
  "seeking",
  "discusses",
  "discussing",
  "helps",
  "help",
  "helping",
  "tries",
  "trying",
  "attempts",
  "attempting",
  "uses",
  "use",
  "using",
]);

function stripWordPunctuation(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * First topical word in a session's `semanticPreview`, skipping stopwords and
 * generic chat framing ("the user asked...", "user wants..."). Falls back to
 * the first raw token, then the session id, so callers always get something
 * printable for the hover chip / selected bubble title.
 */
export function topicLabelFromPreview(preview: string): string {
  const trimmed = preview.trim();
  if (!trimmed) return "";
  const tokens = trimmed.split(/\s+/).map(stripWordPunctuation).filter(Boolean);
  for (const token of tokens) {
    if (!TOPIC_LABEL_STOPWORDS.has(token.toLowerCase())) {
      return token;
    }
  }
  return tokens[0] ?? "";
}

/**
 * Short per-node label shown on hover and as the title of the click bubble.
 * Derived from the session's own summary so sibling nodes inside the same
 * cluster surface their distinct topics (e.g. "dog" vs "cat") instead of
 * collapsing to the shared cluster keyword.
 */
export function topicMapNodeHoverLabel(node: {
  semanticTitle?: string;
  semanticPreview: string;
  sessionId: string;
}): string {
  const fromTitle = node.semanticTitle?.trim();
  if (fromTitle) return fromTitle;
  const fromPreview = topicLabelFromPreview(node.semanticPreview);
  if (fromPreview) return fromPreview;
  return node.sessionId;
}

export function ChatboxTopicMapPanel({
  chatboxId,
  filter,
  onToggleChip,
  onClearChip: _onClearChip,
  onRebuild,
  rebuildBusy,
}: ChatboxTopicMapPanelProps) {
  const { latestRun, snapshot, snapshotError, isLoading } = useChatboxTopicMap({
    chatboxId,
    enabled: true,
  });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearch = useDeferredValue(searchQuery.trim().toLowerCase());
  const graphRef = useRef<GraphHandle | null>(null);
  const autoFitKeyRef = useRef<string | null>(null);
  const topicMapSelectionRunIdRef = useRef<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const topicMapPalette = useTopicMapCanvasPalette(panelRef);
  const canvasPalette = useMemo(
    () => topicMapPalette ?? DEFAULT_CANVAS_PALETTE,
    [topicMapPalette],
  );
  const graphLayoutKey = snapshot?.runId ?? null;
  const { ref: graphAreaRef, size } = useElementSize<HTMLDivElement>(graphLayoutKey);

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
        semanticTitle: node.semanticTitle,
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
            semanticTitle: node.semanticTitle,
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

  const communities = useMemo(
    () =>
      [...(snapshot?.clusters ?? [])].sort(
        (left, right) => right.memberCount - left.memberCount,
      ),
    [snapshot?.clusters],
  );

  useEffect(() => {
    if (!snapshot) {
      topicMapSelectionRunIdRef.current = null;
      setSelectedNodeId(null);
      return;
    }
    const runId = snapshot.runId;
    if (topicMapSelectionRunIdRef.current !== runId) {
      topicMapSelectionRunIdRef.current = runId;
      setSelectedNodeId(snapshot.nodes[0]?.sessionId ?? null);
      return;
    }
    if (!selectedNodeId) {
      return;
    }
    if (snapshot.nodes.some((node) => node.sessionId === selectedNodeId)) {
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
      // Title for both the hover chip and the selected bubble comes from the
      // session's own summary so the bubble on click reads like
      // "dog" + "The user requested a drawing of a dog..." rather than
      // echoing the cluster label (which is already visible in the sidebar).
      const hoverWord = topicMapNodeHoverLabel(node);
      const fullLabel = hoverWord || node.sessionId;

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
          ? canvasPalette.foreground
          : canvasPalette.mutedForeground;
        ctx.lineWidth = 1.4 / globalScale;
        ctx.arc(node.x, node.y, node.radius + 4.2, 0, 2 * Math.PI);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.fillStyle = dimmed ? canvasPalette.mutedForeground : node.color;
      ctx.arc(node.x, node.y, node.radius, 0, 2 * Math.PI);
      ctx.fill();

      ctx.lineWidth = (isSelected ? 2.4 : isHovered ? 1.4 : 0.9) / globalScale;
      ctx.strokeStyle = isSelected ? canvasPalette.foreground : canvasPalette.border;
      ctx.stroke();

      if (isHovered && !isSelected && hoverWord) {
        const titleFontSize = 11 / globalScale;
        const paddingX = 9 / globalScale;
        const paddingY = 7 / globalScale;
        const gap = 10 / globalScale;

        ctx.font = `600 ${titleFontSize}px ui-sans-serif, system-ui, sans-serif`;
        const titleWidth = ctx.measureText(hoverWord).width;
        const bubbleWidth = titleWidth + paddingX * 2;
        const bubbleHeight = titleFontSize + paddingY * 2;
        const bubbleX = node.x - bubbleWidth / 2;
        const bubbleY = node.y - node.radius - gap - bubbleHeight;

        ctx.save();
        ctx.globalAlpha = dimmed ? 0.55 : 0.98;
        drawRoundedRect(
          ctx,
          bubbleX,
          bubbleY,
          bubbleWidth,
          bubbleHeight,
          10 / globalScale,
        );
        ctx.fillStyle = canvasPalette.card;
        ctx.globalAlpha = dimmed ? 0.45 : 0.96;
        ctx.strokeStyle = canvasPalette.border;
        ctx.lineWidth = 1 / globalScale;
        ctx.fill();
        ctx.stroke();
        ctx.globalAlpha = 1;

        ctx.font = `600 ${titleFontSize}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillStyle = canvasPalette.foreground;
        ctx.fillText(
          hoverWord,
          bubbleX + paddingX,
          bubbleY + paddingY + titleFontSize * 0.82,
        );
        ctx.restore();
      }

      if (isSelected) {
        const titleFontSize = 13 / globalScale;
        const previewFontSize = 10 / globalScale;
        const paddingX = 10 / globalScale;
        const paddingY = 8 / globalScale;
        const gap = 12 / globalScale;
        const preview = trimPreview(node.semanticPreview);

        ctx.font = `600 ${titleFontSize}px ui-sans-serif, system-ui, sans-serif`;
        const titleWidth = ctx.measureText(fullLabel).width;
        let bubbleWidth = titleWidth + paddingX * 2;
        let bubbleHeight = titleFontSize + paddingY * 2;

        ctx.font = `400 ${previewFontSize}px ui-sans-serif, system-ui, sans-serif`;
        bubbleWidth = Math.max(
          bubbleWidth,
          ctx.measureText(preview).width + paddingX * 2,
        );
        bubbleHeight += previewFontSize + 6 / globalScale;

        const bubbleX = node.x - bubbleWidth / 2;
        const bubbleY = node.y + node.radius + gap;

        ctx.save();
        ctx.globalAlpha = dimmed ? 0.55 : 0.98;
        drawRoundedRect(
          ctx,
          bubbleX,
          bubbleY,
          bubbleWidth,
          bubbleHeight,
          14 / globalScale,
        );
        ctx.fillStyle = canvasPalette.card;
        ctx.globalAlpha = dimmed ? 0.45 : 0.96;
        ctx.strokeStyle = canvasPalette.border;
        ctx.lineWidth = 1 / globalScale;
        ctx.fill();
        ctx.stroke();
        ctx.globalAlpha = 1;

        ctx.font = `600 ${titleFontSize}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillStyle = canvasPalette.foreground;
        ctx.fillText(
          fullLabel,
          bubbleX + paddingX,
          bubbleY + paddingY + titleFontSize * 0.82,
        );

        ctx.font = `400 ${previewFontSize}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillStyle = canvasPalette.mutedForeground;
        ctx.fillText(
          preview,
          bubbleX + paddingX,
          bubbleY + bubbleHeight - paddingY,
        );
        ctx.restore();
      }

      ctx.restore();
    },
    [
      canvasPalette.border,
      canvasPalette.card,
      canvasPalette.foreground,
      canvasPalette.mutedForeground,
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
      if (!sourceId || !targetId) {
        return faintLine(canvasPalette.mutedForeground, 14);
      }
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

      if (touchesSelection) return faintLine(canvasPalette.foreground, 42);
      if (touchesHover && sourceNode) return hexToRgba(sourceNode.color, 0.34);
      if (dimmed) return faintLine(canvasPalette.mutedForeground, 6);
      if (
        sourceNode &&
        targetNode &&
        sourceNode.clusterId &&
        sourceNode.clusterId === targetNode.clusterId
      ) {
        return hexToRgba(sourceNode.color, 0.22);
      }
      return faintLine(canvasPalette.border, 28);
    },
    [
      canvasPalette.border,
      canvasPalette.foreground,
      canvasPalette.mutedForeground,
      hoveredNodeId,
      isNodeDimmed,
      nodeById,
      selectedNodeId,
    ],
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

      // Cluster halos are always rendered regardless of hover/selection/search
      // dimming so operators can see the full cluster landscape at all times.
      for (const node of graphData.nodes) {
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
    [graphData],
  );

  if (
    !snapshot &&
    (isLoading ||
      latestRun?.status === "running" ||
      latestRun?.status === "queued")
  ) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-background text-foreground">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <LoaderCircle className="h-8 w-8 animate-spin text-primary" />
          <div>
            <p className="text-sm font-medium">Building the historical topic map</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Sessions are being summarized, clustered, and laid out for the graph.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-background text-foreground">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          {latestRun?.status === "failed" ? (
            <AlertTriangle className="h-8 w-8 text-destructive" />
          ) : (
            <Network className="h-8 w-8 text-muted-foreground" />
          )}
          <div>
            <p className="text-sm font-medium">
              {latestRun?.status === "failed"
                ? "Topic map rebuild failed"
                : "No topic map snapshot yet"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {snapshotError ??
                latestRun?.errorMessage ??
                "Run a rebuild to summarize and cluster historical sessions."}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
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
    <div
      ref={panelRef}
      className="flex h-full min-h-0 overflow-hidden bg-background text-foreground"
    >
      <div
        ref={graphAreaRef}
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/8 via-transparent to-muted/50" />
        <div
          className="pointer-events-none absolute inset-0 text-border/40 [background-image:linear-gradient(to_right,currentColor_1px,transparent_1px),linear-gradient(to_bottom,currentColor_1px,transparent_1px)] [background-size:40px_40px] opacity-60 [mask-image:radial-gradient(circle_at_50%_45%,black,transparent_100%)]"
        />

        <div className="absolute left-4 right-4 top-4 z-10 flex flex-wrap items-start gap-3">
          <div className="space-y-2">
            {latestRun?.status === "running" ||
            latestRun?.status === "queued" ||
            latestRun?.status === "failed" ? (
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[11px] font-medium",
                    formatRunTone(latestRun),
                  )}
                >
                  {latestRun?.status === "running"
                    ? "Updating historical topic map"
                    : latestRun?.status === "queued"
                      ? "Queued for rebuild"
                      : "Last rebuild failed"}
                </span>
              </div>
            ) : null}
            {snapshot.isSampled ? (
              <div className="max-w-xl rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-warning-foreground">
                Showing a stable 10,000-session sample of{" "}
                {snapshot.stats.mappedSessionCount.toLocaleString()} mapped
                sessions for this chatbox.
              </div>
            ) : null}
          </div>
        </div>

        <div className="pointer-events-none absolute bottom-4 left-4 z-10 flex flex-wrap items-center gap-2">
          <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background/80 p-1.5 shadow-sm backdrop-blur">
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Fit view"
                  onClick={() => fitGraph()}
                >
                  <LocateFixed className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                Fit view
              </TooltipContent>
            </Tooltip>
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant={
                    latestRun?.isStale ||
                    (snapshot.stats.unmappedSessionCount > 0 &&
                      latestRun?.status === "done")
                      ? "default"
                      : "outline"
                  }
                  size="icon"
                  className={cn(
                    "relative",
                    (latestRun?.isStale ||
                      (snapshot.stats.unmappedSessionCount > 0 &&
                        latestRun?.status === "done")) &&
                      "bg-warning text-warning-foreground hover:bg-warning/90",
                  )}
                  aria-label={rebuildButtonLabel(
                    latestRun,
                    snapshot.stats.unmappedSessionCount,
                  )}
                  disabled={rebuildDisabled(latestRun) || rebuildBusy}
                  onClick={onRebuild}
                >
                  <RefreshCw
                    className={cn(
                      "h-3.5 w-3.5",
                      latestRun?.status === "running" && !latestRun.isStale
                        ? "animate-spin"
                        : "",
                    )}
                  />
                  {(latestRun?.isStale ||
                    (snapshot.stats.unmappedSessionCount > 0 &&
                      latestRun?.status === "done")) && (
                    <span className="absolute -right-1 -top-1 flex h-2.5 w-2.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-75" />
                      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-warning ring-2 ring-background" />
                    </span>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {rebuildButtonLabel(
                  latestRun,
                  snapshot.stats.unmappedSessionCount,
                )}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div
          className="h-full min-h-0 w-full"
          data-selected-session={selectedNodeId ?? ""}
        >
          <ForceGraph2D
            ref={graphRef as never}
            graphData={graphData ?? { nodes: [], links: [] }}
            width={size.width}
            height={size.height}
            backgroundColor="rgba(0,0,0,0)"
            nodeCanvasObjectMode={() => "replace"}
            nodeCanvasObject={drawNode}
            nodeLabel={() => ""}
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
              setSelectedNodeId(null);
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
              gradient.addColorStop(0, faintLine(canvasPalette.foreground, 3));
              gradient.addColorStop(1, "transparent");
              ctx.fillStyle = gradient;
              ctx.fillRect(0, 0, size.width, size.height);
            }}
          />
        </div>
      </div>

      <aside className="flex w-[372px] shrink-0 flex-col border-l border-border bg-muted/30">
        <div className="space-y-3 border-b border-border bg-muted/20 p-4">
          <SearchInput
            value={searchQuery}
            onValueChange={(value) => startTransition(() => setSearchQuery(value))}
            placeholder="Search nodes..."
          />
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-3 p-4">
              {communities.map((community) => {
                const isActive = activeClusterIds.has(community.clusterId);
                const swatch = colorForCluster(
                  community.clusterId,
                  clusterColorIndex.get(community.clusterId) ?? 0,
                );
                return (
                  <div
                    key={community.clusterId}
                    className={cn(
                      "w-full rounded-lg border px-3 py-3 text-left transition",
                      isActive
                        ? "border-primary/40 bg-primary/10"
                        : "border-border bg-card hover:bg-muted/50",
                    )}
                  >
                    <button
                      type="button"
                      className="w-full text-left"
                      onClick={() =>
                        onToggleChip({
                          kind: "cluster",
                          clusterId: community.clusterId,
                          label: community.label,
                        })
                      }
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              className="h-2.5 w-2.5 rounded-full"
                              style={{ backgroundColor: swatch }}
                            />
                          <p className="truncate text-sm font-semibold text-foreground">
                            {community.label}
                          </p>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {community.summary}
                          </p>
                        </div>
                        <span className="rounded-full bg-secondary px-2 py-1 text-[11px] text-secondary-foreground">
                          {community.memberCount}
                        </span>
                      </div>
                    </button>
                    {community.keywords.length > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {community.keywords.map((keyword) => (
                          <span
                            key={keyword}
                            className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground"
                          >
                            {keyword}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </div>
      </aside>
    </div>
  );
}
