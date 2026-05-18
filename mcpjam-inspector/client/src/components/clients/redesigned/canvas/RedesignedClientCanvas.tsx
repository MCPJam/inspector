import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { motion } from "framer-motion";
import {
  BaseEdge,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
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
import {
  SERVER_CARD_LAYOUT_ID,
  SNAPPY_CAMERA,
  SNAPPY_HOST_REVEAL,
} from "../../transition-tokens";
import { HostMatrixCard } from "./ClientCapabilityMatrix";

const decorativeHandleClass = "!opacity-0 !w-2 !h-2";

/**
 * Canvas chrome palette. Declared as CSS custom properties on the canvas
 * root so server hub / cards / pill / controls / dots all read the same
 * tokens. Dark mode swaps lightness while keeping the mint hue for the
 * MCP-server frame — same principle as the inner Host/Sandbox/View card.
 */
const CANVAS_STYLES = `
.host-redesign-canvas {
  --rd-canvas-bg: oklch(0.985 0.005 80);
  --rd-canvas-ring: oklch(0.86 0.008 80);
  --rd-dot: oklch(0.70 0.04 80 / 0.55);

  --rd-server-bg: oklch(0.95 0.035 165);
  --rd-server-ring: oklch(0.84 0.08 165);
  --rd-server-ink: oklch(0.36 0.12 165);
  --rd-server-sub: oklch(0.50 0.10 165);
  --rd-server-surface: white;

  --rd-controls-bg: white;
  --rd-override: oklch(0.55 0.14 70);
}
.dark .host-redesign-canvas {
  --rd-canvas-bg: oklch(0.18 0.005 250);
  --rd-canvas-ring: oklch(0.32 0.008 250);
  --rd-dot: oklch(0.55 0.02 250 / 0.40);

  --rd-server-bg: oklch(0.245 0.04 165);
  --rd-server-ring: oklch(0.40 0.08 165);
  --rd-server-ink: oklch(0.86 0.10 165);
  --rd-server-sub: oklch(0.70 0.08 165);
  --rd-server-surface: oklch(0.27 0.008 250);

  --rd-controls-bg: oklch(0.27 0.008 250);
  --rd-override: oklch(0.80 0.12 70);
}
`;

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
    // Reveal the host card with a brief scale/fade after the page-level
    // crossfade begins. Without this the Cursor card reads as "already
    // there" on click — the demo's host group has the same beat.
    return (
      <motion.div
        className="w-full"
        initial={{ opacity: 0, scale: 0.9, y: 40 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={SNAPPY_HOST_REVEAL}
        style={{ transformOrigin: "50% 0%" }}
      >
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
      </motion.div>
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
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...SNAPPY_HOST_REVEAL, delay: 0.32 }}
        className={cn(
          "flex items-center gap-2 rounded-[12px] border px-3 py-2 shadow-sm transition-all hover:shadow-md",
          selected && "ring-2",
        )}
        style={{
          background: "var(--rd-server-bg)",
          borderColor: "var(--rd-server-ring)",
          color: "var(--rd-server-ink)",
        }}
      >
        <div
          className="flex size-7 items-center justify-center rounded-md"
          style={{
            background: "var(--rd-server-surface)",
            color: "var(--rd-server-sub)",
          }}
        >
          <Server className="size-3.5" />
        </div>
        <div className="flex min-w-0 flex-col leading-tight">
          <span
            className="text-[13px] font-semibold"
            style={{ color: "var(--rd-server-ink)" }}
          >
            MCP servers
          </span>
          <span
            className="text-[10.5px]"
            style={{ color: "var(--rd-server-sub)" }}
          >
            {data.totalCount} attached · provide UI + tools
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
      </motion.div>
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
    // Share layout with the same server's grid card on the Connect "Servers"
    // view — Framer Motion FLIPs between the two rendered rects when the user
    // toggles tabs so each card morphs 1:1 into its pill slot. Full `layout`
    // animates both position and size; the inner motion.div fades the pill
    // content in *after* the box has finished shrinking, which avoids the
    // visible warp that scaling text/icons would cause mid-morph. Mirrors the
    // demo's pattern where inner controls slide to opacity 0 first, the box
    // morphs, then the pill content settles in.
    return (
      <motion.div
        layoutId={SERVER_CARD_LAYOUT_ID(data.serverId)}
        layout
        transition={SNAPPY_CAMERA}
        className={cn(
          "h-full w-full overflow-hidden rounded-[10px] border shadow-sm transition-shadow hover:shadow-md",
          selected && "ring-2",
        )}
        style={{
          background: "var(--rd-server-surface)",
          borderColor: "var(--rd-server-ring)",
        }}
      >
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{
            duration: 0.34,
            delay: 0.55,
            ease: [0.22, 1, 0.36, 1],
          }}
          className="flex h-full w-full flex-col gap-1 px-3 py-2"
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
              style={{
                color: "var(--rd-server-ink)",
                letterSpacing: "-0.005em",
              }}
            >
              {data.name}
            </span>
            <span
              className="text-[10px] uppercase tracking-[0.08em]"
              style={{ color: "var(--rd-server-sub)" }}
            >
              {data.isOptional ? "optional" : "required"}
            </span>
          </div>
          <span
            className="truncate font-mono text-[10.5px]"
            title={data.url ?? "Project server"}
            style={{ color: "var(--rd-server-sub)" }}
          >
            {data.url ?? "Project server"}
          </span>
          {data.hasOverride ? (
            <span
              className="mt-auto text-[10px]"
              style={{ color: "var(--rd-override)" }}
            >
              overrides set
            </span>
          ) : null}
        </motion.div>
        <Handle
          type="target"
          position={Position.Top}
          id="top"
          className={decorativeHandleClass}
        />
      </motion.div>
    );
  },
);
ServerCardNodeRenderer.displayName = "ServerCardNodeRenderer";

const AddServerPillRenderer = memo(
  (_props: NodeProps<Node<AddServerPillNodeData, "redesignAddServer">>) => {
    return (
      <div
        className="flex size-9 items-center justify-center rounded-full border border-dashed shadow-sm transition-colors"
        style={{
          background: "var(--rd-server-surface)",
          borderColor: "var(--rd-server-ring)",
          color: "var(--rd-server-sub)",
        }}
      >
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

/**
 * Both host-canvas edges (matrix→hub trunk and hub→card branches) read
 * their endpoints from `edge.data.fixed{Source,Target}{X,Y}` instead of
 * from ReactFlow's measured handle positions.
 *
 * Why: framer-motion's `layout` + `layoutId` morph on the canvas server
 * pills (and the matrix card's initial scale/y transform) modify the
 * elements' CSS transforms. ReactFlow measures handle positions via
 * `getBoundingClientRect`, which includes those transforms — so the
 * measured target X/Y can be hundreds of px away from where the node
 * actually lives in flow coordinates. That made one branch flap up to
 * the top-right of the canvas (the "giant dashed rectangle" artifact).
 *
 * The canvasBuilder already has authoritative flow coordinates for every
 * node, so just pass them straight through and bypass the measurement.
 */
interface FixedEdgeData {
  fixedSourceX: number;
  fixedSourceY: number;
  fixedTargetX: number;
  fixedTargetY: number;
}

const TRUNK_CORNER = 14;
const BRANCH_CORNER = 8;

function buildOrthogonalTreePath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  cornerRadius: number,
): string {
  const midY = (sourceY + targetY) / 2;
  const goingRight = targetX >= sourceX;
  const dirX = goingRight ? 1 : -1;
  const r = Math.min(
    cornerRadius,
    Math.abs(targetX - sourceX) / 2,
    Math.abs(midY - sourceY),
    Math.abs(targetY - midY),
  );
  if (r <= 0.5) {
    // Source and target vertically aligned — single straight line.
    return `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
  }
  return [
    `M ${sourceX} ${sourceY}`,
    `L ${sourceX} ${midY - r}`,
    `Q ${sourceX} ${midY} ${sourceX + r * dirX} ${midY}`,
    `L ${targetX - r * dirX} ${midY}`,
    `Q ${targetX} ${midY} ${targetX} ${midY + r}`,
    `L ${targetX} ${targetY}`,
  ].join(" ");
}

function makeFixedEdge(cornerRadius: number) {
  return function FixedEdge({ id, data, style, markerEnd }: EdgeProps) {
    const d = data as FixedEdgeData | undefined;
    if (!d) return null;
    const path = buildOrthogonalTreePath(
      d.fixedSourceX,
      d.fixedSourceY,
      d.fixedTargetX,
      d.fixedTargetY,
      cornerRadius,
    );
    return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />;
  };
}

const HostTrunkEdge = makeFixedEdge(TRUNK_CORNER);
const HostBranchEdge = makeFixedEdge(BRANCH_CORNER);

const edgeTypes = {
  hostTrunk: HostTrunkEdge,
  hostBranch: HostBranchEdge,
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

export function RedesignedClientCanvas({
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

  // In read-only mode the matrix sub-regions stopPropagation before
  // invoking onSelectNode — a no-op handler would swallow the click
  // entirely and onNodeClick (which we redirect to onRequestEdit) would
  // never fire. Route the sub-region click directly to onRequestEdit so
  // the whole matrix card stays an editable affordance in read-only mode.
  const matrixCtx = useMemo(
    () =>
      readOnly
        ? {
            selectedNodeId: null,
            onSelectNode: () => onRequestEdit?.(),
          }
        : { selectedNodeId, onSelectNode },
    [selectedNodeId, onSelectNode, readOnly, onRequestEdit],
  );

  // Hold the canvas edges invisible until the server pills have landed at
  // their layoutId destinations AND their inner content has faded in —
  // otherwise the lines render at full opacity while the cards are still
  // morphing in from the Servers grid, which reads as "lines drawn first,
  // then servers". Timing covers SNAPPY_CAMERA (1150ms) + inner-fade tail.
  const [edgesReady, setEdgesReady] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setEdgesReady(true), 1450);
    return () => window.clearTimeout(t);
  }, []);

  // ReactFlow renders nodes at their absolute canvas coordinates first, then
  // applies `fitView` on the next frame, which causes a one-frame "off-center"
  // flash where edges trail off to wherever the nodes are pre-fit. Hide the
  // viewport until onInit fires and fitView has settled, then fade in.
  const [viewportReady, setViewportReady] = useState(false);

  return (
    <div
      className="host-redesign-canvas relative h-full w-full overflow-hidden rounded-[28px] border"
      style={{
        background: "var(--rd-canvas-bg)",
        borderColor: "var(--rd-canvas-ring)",
        ...shellStyle,
      }}
      data-edges-ready={edgesReady ? "true" : "false"}
      data-viewport-ready={viewportReady ? "true" : "false"}
    >
      <style>{CANVAS_STYLES}</style>
      <HostMatrixContext.Provider value={matrixCtx}>
        {/* Inline opacity gate: keeps ReactFlow's pre-fitView paint (nodes
            at raw canvas coords, edges trailing off-screen) invisible until
            fitView has applied. Inline style always wins over the cascade,
            unlike the `data-viewport-ready` CSS attribute selector which was
            getting shadowed by xyflow's own stylesheet in some load orders. */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: viewportReady ? 1 : 0,
            transition: viewportReady
              ? "opacity 220ms cubic-bezier(0.22, 1, 0.36, 1)"
              : "none",
          }}
        >
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
          fitViewOptions={{ padding: 0.18, duration: 0 }}
          onInit={(instance) => {
            // Force a deterministic fit + defer the visibility flip a couple
            // frames so node-measurement and fitView have definitely
            // applied. `requestAnimationFrame` alone fires before
            // ReactFlow's measurement pass on the first render.
            instance.fitView({ padding: 0.18, duration: 0 });
            window.setTimeout(() => setViewportReady(true), 60);
          }}
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
            color="var(--rd-dot)"
            patternClassName="opacity-[0.45]"
          />
          <Controls
            showInteractive={false}
            className="!rounded-xl !border"
            style={{
              background: "var(--rd-controls-bg)",
              borderColor: "var(--rd-canvas-ring)",
            }}
          />
        </ReactFlow>
        </div>
      </HostMatrixContext.Provider>
    </div>
  );
}

export type { HostRedesignViewModel };
