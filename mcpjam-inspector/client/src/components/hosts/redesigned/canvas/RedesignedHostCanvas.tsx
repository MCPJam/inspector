import { createContext, memo, useContext, useMemo, type CSSProperties } from "react";
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
import { cn } from "@/lib/utils";
import {
  type AddServerPillNodeData,
  type HostMatrixNodeData,
  type HostRedesignViewModel,
  type ServerCardNodeData,
  type ServersHubNodeData,
} from "../types";
import { HostMatrixCard } from "./HostCapabilityMatrix";

const decorativeHandleClass = "!opacity-0 !w-2 !h-2";

/* ============================================================
   Sub-region click dispatch. The matrix is a single ReactFlow
   node, but its inner buttons (Agent stats, Protocol band, Apps
   banner, individual cap rows) need to dispatch their OWN ids
   to `onSelectNode` so the focus panel opens the right tab.
   Context threads that callback from the canvas down through
   the node renderer without making it a renderer prop.
   ============================================================ */
const HostMatrixContext = createContext<{
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
} | null>(null);

/* ============================================================
   Host matrix node — the entire host surface in one ReactFlow
   node. Connects to the servers hub below it via the standard
   smooth-step edge.
   ============================================================ */
const HostMatrixNodeRenderer = memo(
  (props: NodeProps<Node<HostMatrixNodeData, "redesignHostMatrix">>) => {
    const { data } = props;
    const ctx = useContext(HostMatrixContext);
    return (
      <div className="w-full">
        <HostMatrixCard
          hostName={data.hostName}
          agent={data.agent}
          protocolBand={data.protocolBand}
          clientCaps={data.clientCaps}
          appsCaps={data.appsCaps}
          sandbox={data.sandbox}
          appsExtensionAdvertised={data.appsExtensionAdvertised}
          hostContext={data.hostContext}
          selectedNodeId={ctx?.selectedNodeId ?? null}
          onSelectNode={ctx?.onSelectNode ?? (() => {})}
        />
        <Handle
          type="source"
          position={Position.Bottom}
          id="bottom"
          className={decorativeHandleClass}
        />
      </div>
    );
  },
);
HostMatrixNodeRenderer.displayName = "HostMatrixNodeRenderer";

/* ============================================================
   Servers hub + server cards + add-server pill. Unchanged from
   the previous design — geometry already scales with server
   count and the canvas-level edges still describe the host's
   dependency on each server.
   ============================================================ */
const ServersHubNodeRenderer = memo(
  (props: NodeProps<Node<ServersHubNodeData, "redesignServersHub">>) => {
    const { data, selected } = props;
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-[10px] border border-border/70 bg-card/95 px-3 py-2 shadow-sm transition-all hover:shadow-md",
          selected && "ring-2 ring-primary/40",
        )}
      >
        <div className="flex size-7 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
          <Server className="size-3.5" />
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="text-[13px] font-semibold">Servers</span>
          <span className="text-[10.5px] text-muted-foreground">
            {data.totalCount} attached
          </span>
        </div>
        <Handle
          type="target"
          position={Position.Top}
          id="top"
          className={decorativeHandleClass}
        />
        <Handle
          type="source"
          position={Position.Bottom}
          id="bottom"
          className={decorativeHandleClass}
        />
      </div>
    );
  },
);
ServersHubNodeRenderer.displayName = "ServersHubNodeRenderer";

/**
 * Map server runtime state + insecure-URL signal to the indicator dot
 * shown next to the server name. Insecure http URLs intentionally win over
 * runtime status — a successfully-connected http server is still worth
 * flagging. "unknown" falls back to muted so the dot doesn't lie when the
 * builder is rendered without runtime context (e.g. in canvas tests).
 */
export function getServerStatusDot(data: {
  insecure: boolean;
  connectionStatus: ServerCardNodeData["connectionStatus"];
}): { dotClass: string; statusLabel: string } {
  if (data.insecure) {
    return { dotClass: "bg-amber-500", statusLabel: "Insecure (http)" };
  }
  switch (data.connectionStatus) {
    case "connected":
      return { dotClass: "bg-emerald-500", statusLabel: "Connected" };
    case "connecting":
    case "oauth-flow":
      return {
        dotClass: "bg-amber-500 animate-pulse",
        statusLabel:
          data.connectionStatus === "oauth-flow"
            ? "OAuth in progress"
            : "Connecting",
      };
    case "failed":
      return { dotClass: "bg-red-500", statusLabel: "Connection failed" };
    case "disconnected":
      return { dotClass: "bg-muted-foreground/40", statusLabel: "Disconnected" };
    case "unknown":
    default:
      return { dotClass: "bg-muted-foreground/30", statusLabel: "Unknown" };
  }
}

const ServerCardNodeRenderer = memo(
  (props: NodeProps<Node<ServerCardNodeData, "redesignServerCard">>) => {
    const { data, selected } = props;
    const { dotClass, statusLabel } = getServerStatusDot(data);
    return (
      <div
        className={cn(
          "flex h-full w-full flex-col gap-1 rounded-[8px] border border-border/70 bg-card/95 px-3 py-2 shadow-sm transition-all hover:shadow-md",
          selected && "ring-2 ring-primary/40",
        )}
      >
        <div className="flex items-center gap-1.5">
          <span
            className={cn("size-1.5 rounded-full", dotClass)}
            aria-label={statusLabel}
            title={statusLabel}
          />
          <span
            className="flex-1 truncate text-[12.5px] font-semibold"
            title={data.name}
          >
            {data.name}
          </span>
          <span className="text-[10px] uppercase tracking-[0.04em] text-muted-foreground/80">
            {data.isOptional ? "optional" : "required"}
          </span>
        </div>
        <span
          className="truncate font-mono text-[10.5px] text-muted-foreground"
          title={data.url ?? "Project server"}
        >
          {data.url ?? "Project server"}
        </span>
        {data.hasOverride ? (
          <span className="mt-auto text-[10px] text-amber-700 dark:text-amber-300">
            overrides set
          </span>
        ) : null}
        <Handle
          type="target"
          position={Position.Top}
          id="top"
          className={decorativeHandleClass}
        />
      </div>
    );
  },
);
ServerCardNodeRenderer.displayName = "ServerCardNodeRenderer";

const AddServerPillRenderer = memo(
  (_props: NodeProps<Node<AddServerPillNodeData, "redesignAddServer">>) => {
    return (
      <div className="flex size-9 items-center justify-center rounded-full border border-dashed border-border/70 bg-card/95 text-muted-foreground shadow-sm">
        <Plus className="size-4" />
      </div>
    );
  },
);
AddServerPillRenderer.displayName = "AddServerPillRenderer";

const nodeTypes = {
  redesignHostMatrix: HostMatrixNodeRenderer,
  redesignServersHub: ServersHubNodeRenderer,
  redesignServerCard: ServerCardNodeRenderer,
  redesignAddServer: AddServerPillRenderer,
};

function HostSmoothEdge(props: EdgeProps) {
  const pathOptions = useMemo(() => ({ borderRadius: 14 }), []);
  return <SmoothStepEdge {...props} pathOptions={pathOptions} />;
}

const edgeTypes = {
  default: HostSmoothEdge,
};

interface RedesignedHostCanvasProps {
  viewModel: HostRedesignViewModel;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  onClearSelection: () => void;
  onAddServer: () => void;
  shellStyle?: CSSProperties;
  /**
   * Read-only mode: rendered identically but inert.
   *
   * - The "add server" pill node is filtered out of the view model so
   *   the user can't request an add.
   * - Node clicks no longer dispatch `onSelectNode` (the focus panel
   *   never opens). Instead, if `onRequestEdit` is supplied, a single
   *   click anywhere in the canvas calls it so the host surface can
   *   route the user to a writable editor (e.g. "open this host in
   *   the Hosts tab").
   * - Selection state is suppressed visually so the canvas reads as
   *   a static summary rather than an interactive picker.
   *
   * Used by the chatbox builder to embed the host viz as a live but
   * uneditable summary of the chatbox's referenced host.
   */
  readOnly?: boolean;
  onRequestEdit?: () => void;
}

export function RedesignedHostCanvas({
  viewModel,
  selectedNodeId,
  onSelectNode,
  onClearSelection,
  onAddServer,
  shellStyle,
  readOnly = false,
  onRequestEdit,
}: RedesignedHostCanvasProps) {
  const filteredNodes = useMemo(
    () =>
      readOnly
        ? viewModel.nodes.filter((node) => node.type !== "redesignAddServer")
        : viewModel.nodes,
    [viewModel.nodes, readOnly],
  );
  const filteredEdges = useMemo(
    () =>
      readOnly
        ? viewModel.edges.filter(
            (edge) => edge.source !== "add-server" && edge.target !== "add-server",
          )
        : viewModel.edges,
    [viewModel.edges, readOnly],
  );
  const nodes = useMemo(
    () =>
      filteredNodes.map((node) =>
        node.type === "redesignAddServer" || node.type === "redesignHostMatrix"
          ? node
          : {
              ...node,
              selected: readOnly ? false : node.id === selectedNodeId,
            },
      ),
    [filteredNodes, selectedNodeId, readOnly],
  );

  // In read-only mode the matrix sub-nodes shouldn't dispatch selection
  // either; pass a no-op so internal click handlers fall through to the
  // canvas-level onNodeClick (which we redirect to onRequestEdit).
  const matrixCtx = useMemo(
    () =>
      readOnly
        ? { selectedNodeId: null, onSelectNode: () => {} }
        : { selectedNodeId, onSelectNode },
    [selectedNodeId, onSelectNode, readOnly],
  );

  return (
    <div
      className="host-redesign-canvas relative h-full w-full overflow-hidden rounded-[28px] border border-border/70 bg-background"
      style={shellStyle}
    >
      <HostMatrixContext.Provider value={matrixCtx}>
        <ReactFlow
          nodes={nodes}
          edges={filteredEdges}
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
          elementsSelectable={!readOnly}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          onNodeClick={(_, node) => {
            if (readOnly) {
              onRequestEdit?.();
              return;
            }
            if (node.id === "add-server") {
              onAddServer();
              return;
            }
            onSelectNode(node.id);
          }}
          onPaneClick={readOnly ? onRequestEdit : onClearSelection}
        >
          <Background
            id="host-redesign-dots"
            variant={BackgroundVariant.Dots}
            gap={16}
            size={0.9}
            color="oklch(0.55 0.02 250 / 0.22)"
            patternClassName="opacity-[0.45]"
          />
          <Controls
            showInteractive={false}
            className="!rounded-xl !border !border-border/70 !bg-card/95"
          />
        </ReactFlow>
      </HostMatrixContext.Provider>
    </div>
  );
}

export type { HostRedesignViewModel };
