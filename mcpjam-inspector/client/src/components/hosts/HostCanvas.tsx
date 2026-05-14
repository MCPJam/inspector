import { memo, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  SmoothStepEdge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Plus, Server } from "lucide-react";
import "@xyflow/react/dist/style.css";
import { Badge } from "@mcpjam/design-system/badge";
import { getChatboxHostLogo } from "@/lib/chatbox-host-style";
import { cn } from "@/lib/utils";
import type {
  HostBuilderAddServerNodeData,
  HostBuilderNodeData,
  HostBuilderViewModel,
} from "./host-builder-types";

const CHIP_STYLES = {
  neutral: "border-border/70 bg-muted/40 text-muted-foreground",
  success: "border-emerald-600/30 bg-emerald-500/10 text-emerald-700",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-700",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-700",
} as const;

function stateRing(state: HostBuilderNodeData["state"]) {
  switch (state) {
    case "attention":
      return "ring-amber-400/40";
    case "ready":
      return "ring-primary/40";
    case "draft":
      return "ring-border/40";
  }
}

const handleClass = "!opacity-0 !w-2 !h-2";

const HostNodeRenderer = memo(
  (props: NodeProps<Node<HostBuilderNodeData, "hostNode">>) => {
    const { data, selected } = props;
    const isHostCard = data.kind === "host";
    const hostStyle = data.hostStyle ?? "claude";
    const hostLogoSrc = isHostCard ? getChatboxHostLogo(hostStyle) : null;

    return (
      <div
        className={cn(
          "host-builder-card relative w-[280px] overflow-visible rounded-xl border border-border/60 px-3.5 py-3 text-card-foreground transition-all",
          isHostCard
            ? "bg-gradient-to-b from-muted/80 to-muted/40 shadow-sm"
            : "bg-card/90",
          selected && "ring-2 shadow-xl",
          stateRing(data.state),
        )}
      >
        {!isHostCard ? (
          <Handle
            type="target"
            position={Position.Top}
            id="top"
            className={handleClass}
          />
        ) : null}

        {isHostCard ? (
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
                title={data.subtitle ?? data.title}
              >
                {data.subtitle ?? data.title}
              </p>
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
        ) : (
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40">
                <Server className="size-3.5" />
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
        )}

        {!isHostCard && data.chips.length > 0 ? (
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

        {isHostCard ? (
          <Handle
            type="source"
            position={Position.Bottom}
            id="bottom"
            className={handleClass}
          />
        ) : null}
      </div>
    );
  },
);
HostNodeRenderer.displayName = "HostNodeRenderer";

const plusHandleButtonClass =
  "nodrag nopan pointer-events-auto flex size-9 items-center justify-center rounded-full border border-border/60 bg-card text-muted-foreground shadow-sm transition-colors hover:bg-primary hover:text-primary-foreground hover:border-primary";

const HostAddServerNodeRenderer = memo(
  (
    props: NodeProps<
      Node<HostBuilderAddServerNodeData, "hostAddServerNode">
    >,
  ) => {
    const label = props.data.label || "Add server";
    return (
      <div className="flex w-10 items-center justify-center">
        <button
          type="button"
          aria-label={label}
          className={plusHandleButtonClass}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Plus className="size-4" />
        </button>
      </div>
    );
  },
);
HostAddServerNodeRenderer.displayName = "HostAddServerNodeRenderer";

const nodeTypes = {
  hostNode: HostNodeRenderer,
  hostAddServerNode: HostAddServerNodeRenderer,
};

function HostSmoothEdge(props: EdgeProps) {
  return (
    <SmoothStepEdge
      {...props}
      pathOptions={useMemo(() => ({ borderRadius: 14 }), [])}
    />
  );
}

const edgeTypes = {
  default: HostSmoothEdge,
};

interface HostCanvasProps {
  viewModel: HostBuilderViewModel;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  onClearSelection: () => void;
  onAddServer: () => void;
}

export function HostCanvas({
  viewModel,
  selectedNodeId,
  onSelectNode,
  onClearSelection,
  onAddServer,
}: HostCanvasProps) {
  const nodes = viewModel.nodes.map((node) =>
    node.type === "hostNode"
      ? { ...node, selected: node.id === selectedNodeId }
      : node,
  );

  return (
    <div className="host-builder-grid relative h-full w-full rounded-[28px] border border-border/70 bg-background">
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
        fitView
        fitViewOptions={{ padding: 0.2 }}
        onNodeClick={(_, node) => {
          if (node.id === "add-server") {
            onAddServer();
            return;
          }
          onSelectNode(node.id);
        }}
        onPaneClick={onClearSelection}
      >
        <Background
          id="host-builder-dots"
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
  );
}
