import {
  createContext,
  memo,
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
  type Node,
  type NodeProps,
  type EdgeProps,
} from "@xyflow/react";
import { Bot, CircleHelp, Network, Plus, Server } from "lucide-react";
import "@xyflow/react/dist/style.css";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { RemoteServer } from "@/hooks/useWorkspaces";
import { WorkspaceServerPickerList } from "@/components/sandboxes/builder/setup-checklist-panel";
import { MCPIcon } from "@/components/ui/mcp-icon";
import { getSandboxHostLogo } from "@/lib/sandbox-host-style";
import { cn } from "@/lib/utils";
import type {
  SandboxBuilderNodeData,
  SandboxBuilderViewModel,
  SandboxSectionLabelData,
} from "./types";
import {
  getSandboxCanvasLayoutSignature,
  SANDBOX_BUILDER_HOST_NODE_ID,
  SANDBOX_BUILDER_NODE_HEIGHT,
  SANDBOX_BUILDER_NODE_WIDTH,
} from "./sandbox-canvas-viewport";

export type SandboxCanvasServerPickerProps = {
  workspaceServers: RemoteServer[];
  selectedServerIds: string[];
  onToggleServer: (serverId: string, checked: boolean) => void;
  onOpenAddWorkspaceServer: () => void;
};

const SandboxCanvasContext = createContext<{
  canvasServerPicker?: SandboxCanvasServerPickerProps;
}>({});

const CHIP_STYLES = {
  neutral: "border-border/70 bg-muted/40 text-muted-foreground",
  success: "border-emerald-600/30 bg-emerald-500/10 text-emerald-700",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-700",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-700",
} as const;

export function getNodeIcon(kind: SandboxBuilderNodeData["kind"]) {
  switch (kind) {
    case "host":
      return Bot;
    case "server":
      return Server;
  }
}

function stateRing(state: SandboxBuilderNodeData["state"]) {
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

function hasTopHandle(kind: SandboxBuilderNodeData["kind"]) {
  return kind === "server";
}

function hasBottomHandle(kind: SandboxBuilderNodeData["kind"]) {
  return kind === "host";
}

const plusHandleButtonClass =
  "nodrag nopan pointer-events-auto flex size-7 items-center justify-center rounded-full border border-border/60 bg-card text-muted-foreground shadow-sm transition-colors hover:bg-primary hover:text-primary-foreground hover:border-primary";

const SandboxNode = memo((props: NodeProps<Node<SandboxBuilderNodeData>>) => {
  const { data, selected } = props;
  const [canvasPickerOpen, setCanvasPickerOpen] = useState(false);
  const Icon = getNodeIcon(data.kind);
  const { canvasServerPicker } = useContext(SandboxCanvasContext);
  const isHostPreview = data.kind === "host";
  const hostStyle = data.hostStyle ?? "claude";
  const hostLogoSrc = isHostPreview ? getSandboxHostLogo(hostStyle) : null;

  return (
    <div
      className={cn(
        "sandbox-builder-card relative w-[280px] overflow-visible rounded-xl border border-border/60 px-3.5 py-3 text-card-foreground transition-all",
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
          <div className="mb-2 flex items-center justify-center gap-2">
            {data.eyebrow ? (
              <Badge
                variant="secondary"
                className="max-w-[min(100%,11rem)] whitespace-normal rounded-md px-2 py-0.5 text-center text-[10px] font-medium uppercase leading-tight tracking-wide text-muted-foreground"
              >
                {data.eyebrow}
              </Badge>
            ) : null}
          </div>
          <div className="flex gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-border/50 bg-background/80 shadow-inner">
              <img
                src={hostLogoSrc ?? undefined}
                alt=""
                className="size-7 object-contain"
              />
            </div>
            <div className="min-w-0 flex-1">
              <p
                className="truncate text-sm font-semibold leading-tight"
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
                <p className="truncate text-sm font-semibold" title={data.title}>
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
                    aria-label="Add workspace servers to sandbox"
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
                    Pick HTTPS servers from your workspace for this sandbox.
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

SandboxNode.displayName = "SandboxNode";

const SectionLabelNode = memo(
  (props: NodeProps<Node<SandboxSectionLabelData, "sectionLabel">>) => {
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
  sandboxNode: SandboxNode,
  sectionLabel: SectionLabelNode,
};

const edgeTypes = {
  smoothRound: SmoothRoundEdge,
};

const VIEWPORT_ANIMATION_DURATION = 400;
const VIEWPORT_FIT_PADDING = 0.18;
const VIEWPORT_SETTLE_DELAY_MS = 50;

interface CanvasViewportControllerProps {
  containerRef: RefObject<HTMLDivElement | null>;
  layoutSignature: string;
}

function CanvasViewportController({
  containerRef,
  layoutSignature,
}: CanvasViewportControllerProps) {
  const {
    fitBounds,
    getNode,
    getNodesBounds,
    viewportInitialized,
  } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const [containerBox, setContainerBox] = useState<{
    width: number;
    height: number;
  }>({ width: 0, height: 0 });

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

    const timer = window.setTimeout(() => {
      /** Wait two frames so panZoom + store width/height match the visible pane. */
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          let bounds = getNodesBounds([SANDBOX_BUILDER_HOST_NODE_ID]);
          if (
            !Number.isFinite(bounds.width) ||
            !Number.isFinite(bounds.height) ||
            bounds.width < 16 ||
            bounds.height < 16
          ) {
            const node = getNode(SANDBOX_BUILDER_HOST_NODE_ID);
            if (!node) return;
            bounds = {
              x: node.position.x,
              y: node.position.y,
              width: SANDBOX_BUILDER_NODE_WIDTH,
              height: SANDBOX_BUILDER_NODE_HEIGHT,
            };
          }
          void fitBounds(bounds, {
            padding: VIEWPORT_FIT_PADDING,
            duration: VIEWPORT_ANIMATION_DURATION,
          });
        });
      });
    }, VIEWPORT_SETTLE_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [
    viewportInitialized,
    nodesInitialized,
    layoutSignature,
    containerBox.width,
    containerBox.height,
    fitBounds,
    getNode,
    getNodesBounds,
  ]);

  return null;
}

interface SandboxCanvasProps {
  viewModel: SandboxBuilderViewModel;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  onClearSelection: () => void;
  canvasServerPicker?: SandboxCanvasServerPickerProps;
}

export function SandboxCanvas({
  viewModel,
  selectedNodeId,
  onSelectNode,
  onClearSelection,
  canvasServerPicker,
}: SandboxCanvasProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const nodes = viewModel.nodes.map((node) =>
    node.type === "sandboxNode"
      ? {
          ...node,
          selected: node.id === selectedNodeId,
        }
      : node,
  );
  const layoutSignature = useMemo(
    () => getSandboxCanvasLayoutSignature(viewModel.nodes),
    [viewModel.nodes],
  );
  const ctxValue = useMemo(
    () => ({ canvasServerPicker }),
    [canvasServerPicker],
  );

  return (
    <SandboxCanvasContext.Provider value={ctxValue}>
      <div
        ref={canvasRef}
        className="sandbox-builder-grid relative h-full w-full rounded-[28px] border border-border/70 bg-background"
      >
        <div className="pointer-events-none absolute right-3 top-3 z-10">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="pointer-events-auto size-10 shrink-0 text-muted-foreground"
                aria-label="About the sandbox layout"
              >
                <CircleHelp className="size-5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              align="end"
              className="max-w-[300px] text-balance text-sm"
            >
              This diagram maps your sandbox: servers, tools, and the chat
              experience. Choose a Claude-style or ChatGPT-style host and other
              behavior in Setup. Preview shows what end users will see.
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
          />
          <Background
            id="sandbox-builder-dots"
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
    </SandboxCanvasContext.Provider>
  );
}
