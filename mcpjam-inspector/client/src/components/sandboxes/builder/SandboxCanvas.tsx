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
  Controls,
  Handle,
  Position,
  ReactFlow,
  SmoothStepEdge,
  useReactFlow,
  type HandleProps,
  type Node,
  type NodeProps,
  type EdgeProps,
} from "@xyflow/react";
import {
  Bot,
  ChevronRight,
  Network,
  Plus,
  Server,
} from "lucide-react";
import "@xyflow/react/dist/style.css";
import { Badge } from "@/components/ui/badge";
import { MCPIcon } from "@/components/ui/mcp-icon";
import { cn } from "@/lib/utils";
import type {
  SandboxBuilderNodeData,
  SandboxBuilderViewModel,
  SandboxSectionLabelData,
} from "./types";
import {
  getSandboxCanvasCenter,
  getSandboxCanvasLayoutSignature,
} from "./sandbox-canvas-viewport";

const SandboxCanvasContext = createContext<{ onAddServer?: () => void }>({});

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

function ButtonHandle({
  onClick,
  ...handleProps
}: Omit<HandleProps, "children"> & { onClick?: () => void }) {
  return (
    <>
      <Handle {...handleProps} />
      <div className="absolute left-1/2 bottom-0 -translate-x-1/2 translate-y-full flex flex-col items-center pointer-events-none">
        <div className="h-10 w-px border-l border-dashed border-border/60" />
        <button
          type="button"
          onClick={onClick}
          className="nodrag nopan pointer-events-auto flex size-7 items-center justify-center rounded-full border border-border/60 bg-card text-muted-foreground shadow-sm transition-colors hover:bg-primary hover:text-primary-foreground hover:border-primary"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
    </>
  );
}

const SandboxNode = memo((props: NodeProps<Node<SandboxBuilderNodeData>>) => {
  const { data, selected } = props;
  const Icon = getNodeIcon(data.kind);
  const { onAddServer } = useContext(SandboxCanvasContext);

  return (
    <div
      className={cn(
        "sandbox-builder-card relative w-[220px] overflow-visible rounded-xl border border-border/60 bg-card/90 px-3.5 py-3 text-card-foreground transition-all",
        selected && "ring-2 shadow-xl",
        stateRing(data.state),
      )}
    >
      {hasTopHandle(data.kind) && (
        <Handle type="target" position={Position.Top} id="top" className={handleClass} />
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40"
          >
            <Icon className="size-3.5" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{data.title}</p>
            {data.subtitle ? (
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                {data.subtitle}
              </p>
            ) : null}
          </div>
        </div>
        {selected ? <ChevronRight className="mt-0.5 size-4 text-muted-foreground" /> : null}
      </div>

      {data.chips.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {data.chips.map((item) => (
            <Badge
              key={`${data.kind}:${item.label}`}
              variant="outline"
              className={cn("rounded-full text-[10px]", CHIP_STYLES[item.tone ?? "neutral"])}
            >
              {item.label}
            </Badge>
          ))}
        </div>
      ) : null}
      {data.kind === "host" ? (
        <ButtonHandle
          type="source"
          position={Position.Bottom}
          id="bottom"
          className={handleClass}
          onClick={onAddServer}
        />
      ) : hasBottomHandle(data.kind) ? (
        <Handle type="source" position={Position.Bottom} id="bottom" className={handleClass} />
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
        <span className="shrink-0 text-muted-foreground/60">{props.data.label}</span>
        <span className="h-px flex-1 bg-border/40" />
      </div>
    );
  },
);

SectionLabelNode.displayName = "SectionLabelNode";

function SmoothRoundEdge(props: EdgeProps) {
  return <SmoothStepEdge {...props} pathOptions={useMemo(() => ({ borderRadius: 14 }), [])} />;
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
  center: { x: number; y: number } | null;
}

function CanvasViewportController({
  containerRef,
  layoutSignature,
  center,
}: CanvasViewportControllerProps) {
  const reactFlow = useReactFlow();
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const lastLayoutSignatureRef = useRef<string | null>(null);
  const lastContainerWidthRef = useRef<number | null>(null);
  const hasFitViewportRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const updateWidth = (nextWidth: number) => {
      setContainerWidth((currentWidth) =>
        currentWidth !== null && Math.abs(currentWidth - nextWidth) < 1
          ? currentWidth
          : nextWidth,
      );
    };

    updateWidth(container.getBoundingClientRect().width);

    const observer = new ResizeObserver((entries) => {
      const observedWidth = entries[0]?.contentRect.width ?? container.getBoundingClientRect().width;
      updateWidth(observedWidth);
    });

    observer.observe(container);

    return () => observer.disconnect();
  }, [containerRef]);

  useEffect(() => {
    if (!layoutSignature) {
      return;
    }

    const layoutChanged = lastLayoutSignatureRef.current !== layoutSignature;
    lastLayoutSignatureRef.current = layoutSignature;

    if (!layoutChanged) {
      return;
    }

    const timer = window.setTimeout(() => {
      reactFlow.fitView({
        padding: VIEWPORT_FIT_PADDING,
        duration: VIEWPORT_ANIMATION_DURATION,
      });
      hasFitViewportRef.current = true;
      if (containerRef.current) {
        lastContainerWidthRef.current = containerRef.current.getBoundingClientRect().width;
      }
    }, VIEWPORT_SETTLE_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [containerRef, layoutSignature, reactFlow]);

  useEffect(() => {
    if (!center || containerWidth === null) {
      return;
    }

    if (lastContainerWidthRef.current === null) {
      lastContainerWidthRef.current = containerWidth;
      return;
    }

    if (Math.abs(lastContainerWidthRef.current - containerWidth) < 1) {
      return;
    }

    lastContainerWidthRef.current = containerWidth;

    if (!hasFitViewportRef.current) {
      return;
    }

    const timer = window.setTimeout(() => {
      reactFlow.setCenter(center.x, center.y, {
        zoom: reactFlow.getZoom(),
        duration: VIEWPORT_ANIMATION_DURATION,
      });
    }, VIEWPORT_SETTLE_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [center, containerWidth, reactFlow]);

  return null;
}

interface SandboxCanvasProps {
  viewModel: SandboxBuilderViewModel;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  onClearSelection: () => void;
  onAddServer?: () => void;
}

export function SandboxCanvas({
  viewModel,
  selectedNodeId,
  onSelectNode,
  onClearSelection,
  onAddServer,
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
  const layoutCenter = useMemo(
    () => getSandboxCanvasCenter(viewModel.nodes),
    [viewModel.nodes],
  );

  const ctxValue = useMemo(() => ({ onAddServer }), [onAddServer]);

  return (
    <SandboxCanvasContext.Provider value={ctxValue}>
      <div
        ref={canvasRef}
        className="sandbox-builder-grid h-full w-full rounded-[28px] border border-border/70 bg-background"
      >
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
            center={layoutCenter}
          />
          <Background />
          <Controls
            showInteractive={false}
            className="!rounded-xl !border !border-border/70 !bg-card/95"
          />
        </ReactFlow>
      </div>
    </SandboxCanvasContext.Provider>
  );
}
