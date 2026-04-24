import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  SmoothStepEdge,
  useNodesInitialized,
  useReactFlow,
  useUpdateNodeInternals,
  type Node,
  type NodeProps,
  type EdgeProps,
} from "@xyflow/react";
import {
  Bot,
  ChevronDown,
  CircleHelp,
  Loader2,
  Network,
  Plus,
  Server,
} from "lucide-react";
import "@xyflow/react/dist/style.css";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { HOSTED_MODE } from "@/lib/config";
import { listTools } from "@/lib/apis/mcp-tools-api";
import type { RemoteServer } from "@/hooks/useWorkspaces";
import { WorkspaceServerPickerList } from "@/components/chatboxes/builder/setup-checklist-panel";
import { MCPIcon } from "@/components/ui/mcp-icon";
import { getChatboxHostLogo } from "@/lib/chatbox-host-style";
import { cn } from "@/lib/utils";
import type {
  ChatboxBuilderNodeData,
  ChatboxBuilderViewModel,
  ChatboxFlowNode,
  ChatboxSectionLabelData,
} from "./types";
import {
  extendChatboxViewportBoundsForHostOverflow,
  getChatboxBuilderRenderableNodeIds,
  getChatboxCanvasLayoutSignature,
  getChatboxCanvasStaticFitBounds,
} from "./chatbox-canvas-viewport";

export type ChatboxCanvasServerPickerProps = {
  workspaceServers: RemoteServer[];
  selectedServerIds: string[];
  onToggleServer: (serverId: string, checked: boolean) => void;
  onOpenAddWorkspaceServer: () => void;
};

const ChatboxCanvasContext = createContext<{
  canvasServerPicker?: ChatboxCanvasServerPickerProps;
  /** Chatbox draft model; forwarded to tools/list when loading server tools. */
  builderModelId?: string;
}>({});

const TOOLS_LIST_MAX_PAGES = 24;

async function fetchAllToolNames(
  serverId: string,
  modelId: string | undefined,
): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < TOOLS_LIST_MAX_PAGES; page++) {
    const data = await listTools({ serverId, modelId, cursor });
    for (const t of data.tools ?? []) {
      if (typeof t.name === "string" && t.name.length > 0) {
        names.push(t.name);
      }
    }
    cursor =
      typeof data.nextCursor === "string" && data.nextCursor.length > 0
        ? data.nextCursor
        : undefined;
    if (!cursor) break;
  }
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

function ServerNodeToolsCollapsible({
  nodeId,
  serverDocumentId,
  workspaceServers,
  builderModelId,
}: {
  nodeId: string;
  serverDocumentId: string;
  workspaceServers: RemoteServer[] | undefined;
  builderModelId: string | undefined;
}) {
  const updateNodeInternals = useUpdateNodeInternals();
  const toolsListServerId = useMemo(
    () =>
      HOSTED_MODE
        ? serverDocumentId
        : (workspaceServers?.find((s) => s._id === serverDocumentId)?.name ??
          serverDocumentId),
    [serverDocumentId, workspaceServers],
  );

  const [open, setOpen] = useState(false);
  const [toolNames, setToolNames] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlightRef = useRef(false);

  useEffect(() => {
    setToolNames(null);
    setError(null);
    setLoading(false);
    setOpen(false);
    inFlightRef.current = false;
  }, [toolsListServerId]);

  const load = useCallback(async () => {
    if (!toolsListServerId || inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const names = await fetchAllToolNames(toolsListServerId, builderModelId);
      setToolNames(names);
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Could not load tools for this server.";
      setError(message);
      setToolNames(null);
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [toolsListServerId, builderModelId]);

  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next && toolNames === null && !inFlightRef.current) {
        void load();
      }
    },
    [load, toolNames],
  );

  useEffect(() => {
    updateNodeInternals(nodeId);
  }, [nodeId, open, loading, toolNames, error, updateNodeInternals]);

  const countSuffix =
    toolNames === null ? "" : ` (${toolNames.length})`;

  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="mt-3">
      <CollapsibleTrigger
        type="button"
        className="nodrag nopan pointer-events-auto flex w-full items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span>
          Tools
          {countSuffix}
        </span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 opacity-70 transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=closed]:animate-none">
        <div className="mt-1.5 max-h-36 overflow-y-auto rounded-md border border-border/50 bg-background/80 px-2 py-1.5">
          {loading ? (
            <div className="flex items-center gap-2 py-1 text-[11px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Loading tools…
            </div>
          ) : error ? (
            <p className="text-[11px] leading-snug text-destructive">{error}</p>
          ) : toolNames && toolNames.length > 0 ? (
            <ul className="space-y-0.5 text-[11px] leading-snug text-foreground">
              {toolNames.map((name) => (
                <li key={name} className="font-mono">
                  {name}
                </li>
              ))}
            </ul>
          ) : toolNames ? (
            <p className="text-[11px] text-muted-foreground">
              No tools reported by this server.
            </p>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const CHIP_STYLES = {
  neutral: "border-border/70 bg-muted/40 text-muted-foreground",
  success: "border-emerald-600/30 bg-emerald-500/10 text-emerald-700",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-700",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-700",
} as const;

export function getNodeIcon(kind: ChatboxBuilderNodeData["kind"]) {
  switch (kind) {
    case "host":
      return Bot;
    case "server":
      return Server;
  }
}

function stateRing(state: ChatboxBuilderNodeData["state"]) {
  switch (state) {
    case "live":
      return "ring-emerald-400/50";
    case "attention":
      return "ring-amber-400/40";
    case "ready":
      return "ring-primary/40";
    case "draft":
      return "ring-border/40";
  }
}

const handleClass = "!opacity-0 !w-2 !h-2";

function hasTopHandle(kind: ChatboxBuilderNodeData["kind"]) {
  return kind === "server";
}

function hasBottomHandle(kind: ChatboxBuilderNodeData["kind"]) {
  return kind === "host";
}

const plusHandleButtonClass =
  "nodrag nopan pointer-events-auto flex size-7 items-center justify-center rounded-full border border-border/60 bg-card text-muted-foreground shadow-sm transition-colors hover:bg-primary hover:text-primary-foreground hover:border-primary";

const ChatboxNode = memo((props: NodeProps<Node<ChatboxBuilderNodeData>>) => {
  const { id, data, selected } = props;
  const [canvasPickerOpen, setCanvasPickerOpen] = useState(false);
  const Icon = getNodeIcon(data.kind);
  const { canvasServerPicker, builderModelId } = useContext(
    ChatboxCanvasContext,
  );
  const isHostPreview = data.kind === "host";
  const hostStyle = data.hostStyle ?? "claude";
  const hostLogoSrc = isHostPreview ? getChatboxHostLogo(hostStyle) : null;

  return (
    <div
      className={cn(
        "chatbox-builder-card relative w-[280px] overflow-visible rounded-xl border border-border/60 px-3.5 py-3 text-card-foreground transition-all",
        isHostPreview
          ? "bg-gradient-to-b from-muted/80 to-muted/40 shadow-sm"
          : "bg-card/90",
        selected && "ring-2 shadow-xl",
        stateRing(data.state),
      )}
    >
      {hasTopHandle(data.kind) && (
        <Handle
          type="target"
          position={Position.Top}
          id="top"
          className={handleClass}
        />
      )}
      {isHostPreview ? (
        <>
          <div className="flex gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-border/50 bg-background/80 shadow-inner">
              <img
                src={hostLogoSrc ?? undefined}
                alt=""
                className="size-7 object-contain"
              />
            </div>
            <div className="min-w-0 flex-1">
              {data.subtitle ? (
                <p
                  className="truncate text-sm font-semibold leading-tight"
                  title={data.subtitle}
                >
                  {data.subtitle}
                </p>
              ) : (
                <p
                  className="truncate text-sm font-semibold leading-tight"
                  title={data.title}
                >
                  {data.title}
                </p>
              )}
              {data.detailLine ? (
                <p
                  className="mt-1.5 text-[11px] text-muted-foreground/90"
                  title={data.detailLine}
                >
                  {data.detailLine}
                </p>
              ) : null}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40">
                <Icon className="size-3.5" />
              </div>
              <div className="min-w-0">
                <p
                  className="truncate text-sm font-semibold"
                  title={data.title}
                >
                  {data.title}
                </p>
                {data.subtitle ? (
                  <p
                    className="mt-1 line-clamp-2 text-xs text-muted-foreground"
                    title={data.subtitle}
                  >
                    {data.subtitle}
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          {data.chips.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {data.chips.map((item) => (
                <Badge
                  key={`${data.kind}:${item.label}`}
                  variant="outline"
                  className={cn(
                    "rounded-full text-[10px]",
                    CHIP_STYLES[item.tone ?? "neutral"],
                  )}
                >
                  {item.label}
                </Badge>
              ))}
            </div>
          ) : null}

          {data.serverId ? (
            <ServerNodeToolsCollapsible
              nodeId={id}
              serverDocumentId={data.serverId}
              workspaceServers={canvasServerPicker?.workspaceServers}
              builderModelId={builderModelId}
            />
          ) : null}
        </>
      )}

      {data.kind === "host" ? (
        <>
          <Handle
            type="source"
            position={Position.Bottom}
            id="bottom"
            className={handleClass}
          />
          <div className="absolute left-1/2 bottom-0 -translate-x-1/2 translate-y-full flex flex-col items-center pointer-events-none">
            <div className="h-10 w-px border-l border-dashed border-border/60" />
            {canvasServerPicker ? (
              <Popover
                open={canvasPickerOpen}
                onOpenChange={setCanvasPickerOpen}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="Add workspace servers to chatbox"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    className={plusHandleButtonClass}
                  >
                    <Plus className="size-3.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="bottom"
                  align="center"
                  sideOffset={8}
                  className="w-80 p-0 z-[100]"
                >
                  <p className="border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
                    Pick HTTPS servers from your workspace for this chatbox.
                  </p>
                  <div className="p-1">
                    <WorkspaceServerPickerList
                      workspaceServers={canvasServerPicker.workspaceServers}
                      selectedServerIds={canvasServerPicker.selectedServerIds}
                      onToggleSelection={(serverId, checked) => {
                        canvasServerPicker.onToggleServer(serverId, checked);
                      }}
                    />
                  </div>
                  <div className="border-t border-border/60 p-1">
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-9 w-full justify-start gap-2 rounded-md px-2 text-sm text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        setCanvasPickerOpen(false);
                        canvasServerPicker.onOpenAddWorkspaceServer();
                      }}
                    >
                      <Plus className="size-4 shrink-0" />
                      Add server to workspace…
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
            ) : (
              <button
                type="button"
                className={plusHandleButtonClass}
                aria-label="Add server"
              >
                <Plus className="size-3.5" />
              </button>
            )}
          </div>
        </>
      ) : hasBottomHandle(data.kind) ? (
        <Handle
          type="source"
          position={Position.Bottom}
          id="bottom"
          className={handleClass}
        />
      ) : null}
    </div>
  );
});

ChatboxNode.displayName = "ChatboxNode";

const SectionLabelNode = memo(
  (props: NodeProps<Node<ChatboxSectionLabelData, "sectionLabel">>) => {
    const Icon = props.data.icon === "mcp" ? MCPIcon : Network;
    return (
      <div className="pointer-events-none flex w-[600px] items-center gap-3 uppercase tracking-[0.18em] text-[11px] text-muted-foreground/70">
        <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-border/40 bg-card/20">
          <Icon className="size-3" />
        </span>
        <span className="shrink-0 text-muted-foreground/60">
          {props.data.label}
        </span>
        <span className="h-px flex-1 bg-border/40" />
      </div>
    );
  },
);

SectionLabelNode.displayName = "SectionLabelNode";

function SmoothRoundEdge(props: EdgeProps) {
  return (
    <SmoothStepEdge
      {...props}
      pathOptions={useMemo(() => ({ borderRadius: 14 }), [])}
    />
  );
}

const nodeTypes = {
  chatboxNode: ChatboxNode,
  sectionLabel: SectionLabelNode,
};

const edgeTypes = {
  smoothRound: SmoothRoundEdge,
};

const VIEWPORT_ANIMATION_DURATION = 400;
const VIEWPORT_FIT_PADDING = 0.18;
const VIEWPORT_SETTLE_DELAY_MS = 50;

function isValidMeasuredFitBounds(bounds: {
  width: number;
  height: number;
}): boolean {
  return (
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width >= 16 &&
    bounds.height >= 16
  );
}

interface CanvasViewportControllerProps {
  containerRef: RefObject<HTMLDivElement | null>;
  layoutSignature: string;
  layoutNodes: ChatboxFlowNode[];
  /** Bumps when setup canvas becomes visible again (mode / mobile sheet) so refit runs even if layout is unchanged. */
  canvasViewportRefitNonce: number;
}

function CanvasViewportController({
  containerRef,
  layoutSignature,
  layoutNodes,
  canvasViewportRefitNonce,
}: CanvasViewportControllerProps) {
  const { fitBounds, getNodesBounds, viewportInitialized } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const [containerBox, setContainerBox] = useState<{
    width: number;
    height: number;
  }>({ width: 0, height: 0 });
  const lastAppliedViewportInputKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const updateBox = (width: number, height: number) => {
      setContainerBox((prev) => {
        if (
          Math.abs(prev.width - width) < 1 &&
          Math.abs(prev.height - height) < 1
        ) {
          return prev;
        }
        return { width, height };
      });
    };

    const rect = container.getBoundingClientRect();
    updateBox(rect.width, rect.height);

    const observer = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr) {
        updateBox(cr.width, cr.height);
        return;
      }
      const r = container.getBoundingClientRect();
      updateBox(r.width, r.height);
    });

    observer.observe(container);

    return () => observer.disconnect();
  }, [containerRef]);

  useEffect(() => {
    if (!viewportInitialized || !nodesInitialized || !layoutSignature) {
      return;
    }
    if (containerBox.width < 1 || containerBox.height < 1) {
      return;
    }

    const renderableIds = getChatboxBuilderRenderableNodeIds(layoutNodes);
    if (renderableIds.length === 0) {
      return;
    }

    const viewportInputKey = `${layoutSignature}|${Math.round(containerBox.width)}|${Math.round(containerBox.height)}|${canvasViewportRefitNonce}`;

    const autoFitCanvas = () => {
      if (viewportInputKey === lastAppliedViewportInputKeyRef.current) {
        return;
      }

      const staticBounds = getChatboxCanvasStaticFitBounds(layoutNodes);
      let bounds = getNodesBounds(renderableIds);
      if (!isValidMeasuredFitBounds(bounds)) {
        if (!staticBounds) {
          return;
        }
        bounds = staticBounds;
      } else {
        bounds = extendChatboxViewportBoundsForHostOverflow(
          bounds,
          layoutNodes,
        );
      }

      void fitBounds(bounds, {
        padding: VIEWPORT_FIT_PADDING,
        duration: VIEWPORT_ANIMATION_DURATION,
      });
      lastAppliedViewportInputKeyRef.current = viewportInputKey;
    };

    const timer = window.setTimeout(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          autoFitCanvas();
        });
      });
    }, VIEWPORT_SETTLE_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [
    viewportInitialized,
    nodesInitialized,
    layoutSignature,
    layoutNodes,
    containerBox.width,
    containerBox.height,
    canvasViewportRefitNonce,
    fitBounds,
    getNodesBounds,
  ]);

  return null;
}

interface ChatboxCanvasProps {
  viewModel: ChatboxBuilderViewModel;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  onClearSelection: () => void;
  canvasServerPicker?: ChatboxCanvasServerPickerProps;
  builderModelId?: string;
  /** Incremented by the builder shell when the setup canvas is shown again or mobile setup chrome changes. */
  canvasViewportRefitNonce?: number;
}

export function ChatboxCanvas({
  viewModel,
  selectedNodeId,
  onSelectNode,
  onClearSelection,
  canvasServerPicker,
  builderModelId,
  canvasViewportRefitNonce = 0,
}: ChatboxCanvasProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const nodes = viewModel.nodes.map((node) =>
    node.type === "chatboxNode"
      ? {
          ...node,
          selected: node.id === selectedNodeId,
        }
      : node,
  );
  const layoutSignature = useMemo(
    () => getChatboxCanvasLayoutSignature(viewModel.nodes),
    [viewModel.nodes],
  );
  const ctxValue = useMemo(
    () => ({ canvasServerPicker, builderModelId }),
    [canvasServerPicker, builderModelId],
  );

  return (
    <ChatboxCanvasContext.Provider value={ctxValue}>
      <div
        ref={canvasRef}
        className="chatbox-builder-grid relative h-full w-full rounded-[28px] border border-border/70 bg-background"
      >
        <div className="pointer-events-none absolute right-3 top-3 z-10">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="pointer-events-auto size-10 shrink-0 text-muted-foreground"
                aria-label="About the chatbox layout"
              >
                <CircleHelp className="size-5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              align="end"
              className="max-w-[320px] text-balance text-sm"
            >
              Everything you configure in the panel on the right is reflected in
              this diagram.
            </TooltipContent>
          </Tooltip>
        </div>
        <ReactFlow
          nodes={nodes}
          edges={viewModel.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          minZoom={0.55}
          maxZoom={1.35}
          proOptions={{ hideAttribution: true }}
          panOnDrag
          panOnScroll
          zoomOnScroll
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          onNodeClick={(_, node) => onSelectNode(node.id)}
          onPaneClick={onClearSelection}
        >
          <CanvasViewportController
            containerRef={canvasRef}
            layoutSignature={layoutSignature}
            layoutNodes={viewModel.nodes}
            canvasViewportRefitNonce={canvasViewportRefitNonce}
          />
          <Background
            id="chatbox-builder-dots"
            variant={BackgroundVariant.Dots}
            gap={30}
            size={0.9}
            color="oklch(0.55 0.02 250 / 0.22)"
            patternClassName="opacity-[0.4]"
          />
          <Controls
            showInteractive={false}
            className="!rounded-xl !border !border-border/70 !bg-card/95"
          />
        </ReactFlow>
      </div>
    </ChatboxCanvasContext.Provider>
  );
}
