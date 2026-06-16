import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { ArrowRight, ArrowUpRight, Plus, Server, Settings, TerminalSquare } from "lucide-react";
import "@xyflow/react/dist/style.css";
import { cn } from "@/lib/utils";
import { ComputerStatusChip } from "@/components/computer/ComputerStatusChip";
import {
  ADD_SERVER_NODE_ID,
  HOST_MATRIX_NODE_ID,
  SERVERS_HUB_NODE_ID,
  type AddServerPillNodeData,
  type BuiltinToolsNodeData,
  type ComputerNodeData,
  type HostMatrixNodeData,
  type HostRedesignViewModel,
  type ServerCardNodeData,
  type ServersHubNodeData,
} from "../types";
import { SERVERS_HUB_GAP } from "./canvasBuilder";
import {
  SERVER_CARD_LAYOUT_ID,
  SNAPPY_CAMERA,
  SNAPPY_HOST_REVEAL,
} from "../../transition-tokens";
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
  reportMatrixHeight: (height: number) => void;
  /** Navigate to the Computer tab — threaded to the Computer island's "Open terminal" link. */
  onOpenComputer?: () => void;
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
    const containerRef = useRef<HTMLDivElement | null>(null);
    const reportMatrixHeight = ctx?.reportMatrixHeight;
    // Sandbox CSP rows / permissions / View-iframe globals make the card's
    // height content-driven, so the canvas can't precompute where the
    // servers hub belongs. ResizeObserver reads the layout box (transform
    // animations don't pollute it), and the parent shifts the hub + server
    // cards + branch edges by the delta vs. the static estimate.
    useEffect(() => {
      const el = containerRef.current;
      if (!el || !reportMatrixHeight) return;
      const ro = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const box = entry.borderBoxSize?.[0];
        const h = box ? box.blockSize : entry.contentRect.height;
        if (h > 0) reportMatrixHeight(h);
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, [reportMatrixHeight]);
    // Reveal the host card with a brief scale/fade after the page-level
    // crossfade begins. Without this the Cursor card reads as "already
    // there" on click — the demo's host group has the same beat.
    return (
      <motion.div
        ref={containerRef}
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
          hostInfo={data.hostInfo}
          appsExtensionAdvertised={data.appsExtensionAdvertised}
          compatRuntime={data.compatRuntime}
          mcpAppsBridge={data.mcpAppsBridge}
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
          "flex items-center gap-2 rounded-[10px] border border-border/70 bg-card/95 px-3 py-2 shadow-sm transition-shadow hover:shadow-md",
          selected && "ring-2 ring-primary/40",
        )}
      >
        <div className="flex size-7 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
          <Server className="size-3.5" strokeWidth={1.75} />
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="text-[13px] font-semibold text-foreground">
            Servers
          </span>
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
          "h-full w-full overflow-hidden rounded-[8px] border border-border/70 bg-card/95 shadow-sm transition-shadow hover:shadow-md",
          selected && "ring-2 ring-primary/40",
        )}
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
            >
              {data.name}
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
      <div className="flex size-9 items-center justify-center rounded-full border border-dashed border-border/70 bg-card/95 text-muted-foreground shadow-sm">
        <Plus className="size-4" />
      </div>
    );
  },
);
AddServerPillRenderer.displayName = "AddServerPillRenderer";

/* ============================================================
   Project Computers islands. Built-in tools sit to the left of
   the matrix; the Computer island to the right. Both are gated
   in the builder behind `computersEnabled`, so they only ever
   mount when the feature flag is on. A click anywhere on either
   island routes to the Agent (Behavior) tab via onNodeClick →
   onSelectNode → focusTabForNodeId.
   ============================================================ */
const BuiltinToolsNodeRenderer = memo(
  (props: NodeProps<Node<BuiltinToolsNodeData, "redesignBuiltinTools">>) => {
    const { data, selected } = props;
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...SNAPPY_HOST_REVEAL, delay: 0.32 }}
        className={cn(
          "flex w-full flex-col gap-2 rounded-[10px] border border-border/70 bg-card/95 px-3 py-2.5 shadow-sm transition-shadow hover:shadow-md",
          selected && "ring-2 ring-primary/40",
        )}
      >
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
            <Settings className="size-3.5" strokeWidth={1.75} />
          </div>
          <div className="flex min-w-0 flex-col">
            <span className="text-[13px] font-semibold text-foreground">
              Built-in tools
            </span>
            <span className="text-[10.5px] text-muted-foreground">
              {data.tools.length === 0
                ? "None enabled"
                : `${data.tools.length} enabled`}
            </span>
          </div>
        </div>
        {data.tools.length === 0 ? (
          <span className="border-t border-dashed border-border/60 pt-2 text-[11px] text-muted-foreground">
            No built-in tools
          </span>
        ) : (
          <ul className="flex flex-col gap-1 border-t border-dashed border-border/60 pt-2">
            {data.tools.map((tool) => (
              <li
                key={tool.id}
                className="flex items-center justify-between gap-2 text-[11.5px]"
              >
                <span
                  className="truncate font-medium text-foreground"
                  title={tool.label}
                >
                  {tool.label}
                </span>
                {tool.requiresComputer ? (
                  <span
                    className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground"
                    title="Runs on the attached computer"
                  >
                    <ArrowRight className="size-2.5" />
                    <TerminalSquare className="size-3" strokeWidth={1.75} />
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <Handle
          type="target"
          position={Position.Right}
          id="right"
          className={decorativeHandleClass}
        />
      </motion.div>
    );
  },
);
BuiltinToolsNodeRenderer.displayName = "BuiltinToolsNodeRenderer";

const ComputerNodeRenderer = memo(
  (props: NodeProps<Node<ComputerNodeData, "redesignComputer">>) => {
    const { data, selected } = props;
    const ctx = useContext(HostMatrixContext);
    const onOpenComputer = ctx?.onOpenComputer;

    if (!data.attached) {
      // Ghost state — no attachment intent. A click routes to the Agent
      // tab (via onNodeClick) where the "Personal computer" toggle lives.
      return (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...SNAPPY_HOST_REVEAL, delay: 0.32 }}
          className={cn(
            "flex w-full flex-col gap-1 rounded-[10px] border border-dashed border-border/70 bg-card/60 px-3 py-2.5 text-muted-foreground shadow-sm transition-shadow hover:shadow-md",
            selected && "ring-2 ring-primary/40",
          )}
        >
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-md bg-muted/40">
              <TerminalSquare className="size-3.5" strokeWidth={1.75} />
            </div>
            <span className="text-[13px] font-semibold">+ Computer</span>
          </div>
          <span className="text-[10.5px]">Attach your personal computer</span>
          <Handle
            type="target"
            position={Position.Left}
            id="left"
            className={decorativeHandleClass}
          />
        </motion.div>
      );
    }

    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...SNAPPY_HOST_REVEAL, delay: 0.32 }}
        className={cn(
          "flex w-full flex-col gap-2 rounded-[10px] border border-border/70 bg-card/95 px-3 py-2.5 shadow-sm transition-shadow hover:shadow-md",
          selected && "ring-2 ring-primary/40",
        )}
      >
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
            <TerminalSquare className="size-3.5" strokeWidth={1.75} />
          </div>
          <div className="flex min-w-0 flex-col">
            <span className="text-[13px] font-semibold text-foreground">
              Computer
            </span>
            <span className="truncate text-[10.5px] text-muted-foreground">
              personal · {data.workdir ?? "~/"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-dashed border-border/60 pt-2">
          {data.status === null ? (
            // Attached in config, but no machine reserved yet — distinct
            // from the chip's "Loading…"/"No computer" states.
            <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] text-muted-foreground">
              Not started
            </span>
          ) : (
            <ComputerStatusChip status={data.status} />
          )}
        </div>
        {data.backedToolLabels.length > 0 ? (
          <span
            className="truncate text-[11px] text-muted-foreground"
            title={data.backedToolLabels.join(", ")}
          >
            ↳ {data.backedToolLabels.join(", ")}
          </span>
        ) : null}
        {onOpenComputer ? (
          <button
            type="button"
            onClick={(event) => {
              // Don't also fire the node's onSelectNode (→ Agent tab); this
              // link owns navigation to the Computer tab/terminal.
              event.stopPropagation();
              onOpenComputer();
            }}
            className="flex items-center gap-0.5 self-start text-[11px] font-medium text-primary hover:underline"
          >
            Open terminal
            <ArrowUpRight className="size-3" />
          </button>
        ) : null}
        <Handle
          type="target"
          position={Position.Left}
          id="left"
          className={decorativeHandleClass}
        />
      </motion.div>
    );
  },
);
ComputerNodeRenderer.displayName = "ComputerNodeRenderer";

const nodeTypes = {
  redesignHostMatrix: HostMatrixNodeRenderer,
  redesignServersHub: ServersHubNodeRenderer,
  redesignServerCard: ServerCardNodeRenderer,
  redesignAddServer: AddServerPillRenderer,
  redesignBuiltinTools: BuiltinToolsNodeRenderer,
  redesignComputer: ComputerNodeRenderer,
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

/**
 * Shift the reflowed `hostBranch` edges (host→hub→server cards) down by
 * `dy` to track the matrix card's measured-vs-estimated height delta.
 *
 * Project Computers island edges are deliberately EXCLUDED: they source
 * from the matrix node (`HOST_MATRIX_NODE_ID`), which never reflows — it
 * sits at y=0 and grows downward — while their target island nodes are
 * anchored near the top and aren't part of the servers-block shift. Shifting
 * their baked endpoints by `dy` would slide the connector off the (static)
 * island node, reintroducing the detached-edge artifact the fixed-edge
 * coordinates exist to prevent. Exported for direct unit testing.
 */
export function shiftReflowedBranchEdges(edges: Edge[], dy: number): Edge[] {
  if (dy === 0) return edges;
  return edges.map((edge) => {
    if (edge.type !== "hostBranch" || !edge.data) return edge;
    if (edge.source === HOST_MATRIX_NODE_ID) return edge;
    const d = edge.data as unknown as FixedEdgeData;
    return {
      ...edge,
      data: {
        ...d,
        fixedSourceY: d.fixedSourceY + dy,
        fixedTargetY: d.fixedTargetY + dy,
      },
    };
  });
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

/**
 * Trunk edge uses ReactFlow's measured source/target positions instead of
 * the canvasBuilder's fixed coords, so the line tracks the matrix card's
 * actual rendered bottom rather than the `matrixH` estimate (which the
 * card content doesn't reliably hit, leaving a visible gap + the apparent
 * offset that motivated this edge type).
 *
 * Why this is safe (unlike the branch edges): neither the matrix card nor
 * the servers hub uses framer-motion `layout`/`layoutId`. They only run a
 * one-time mount reveal that settles to an identity transform, so
 * `getBoundingClientRect` — and therefore ReactFlow's measured handle
 * positions — is correct in steady state. The branch edges still need
 * fixed coords because the server cards' `layoutId` morph persistently
 * pollutes their measured rects on every tab switch.
 */
function HostTrunkEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  markerEnd,
}: EdgeProps) {
  const path = buildOrthogonalTreePath(
    sourceX,
    sourceY,
    targetX,
    targetY,
    TRUNK_CORNER,
  );
  return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />;
}

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
  /** Navigate to the Computer tab — wired to the Computer island's "Open terminal" link. */
  onOpenComputer?: () => void;
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
  onOpenComputer,
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

  // Measured height of the host matrix card. The canvasBuilder positions
  // the servers hub from a static height estimate; we shift the hub +
  // server cards + add-server pill + branch-edge endpoints by
  // (measured - estimated) so they always sit `SERVERS_HUB_GAP` below the
  // card's true bottom. 0 means "not measured yet" — fall through to the
  // static positions for the initial frame.
  const [measuredMatrixH, setMeasuredMatrixH] = useState(0);
  const reportMatrixHeight = useCallback((h: number) => {
    setMeasuredMatrixH((prev) =>
      Math.abs(prev - h) < 0.5 ? prev : h,
    );
  }, []);

  // The estimated matrix height the builder used is recoverable from the
  // hub's pre-shift Y: `serversHubY = estimatedMatrixH + SERVERS_HUB_GAP`.
  // Reading it off the hub keeps the shift in sync with whatever section
  // toggles (apps extension on/off) the builder applied.
  const dy = useMemo(() => {
    if (measuredMatrixH <= 0) return 0;
    const hub = filteredNodes.find((n) => n.id === SERVERS_HUB_NODE_ID);
    if (!hub) return 0;
    const estimatedMatrixH = hub.position.y - SERVERS_HUB_GAP;
    return measuredMatrixH - estimatedMatrixH;
  }, [filteredNodes, measuredMatrixH]);

  const shiftedNodes = useMemo(() => {
    if (dy === 0) return filteredNodes;
    return filteredNodes.map((node) => {
      const shouldShift =
        node.id === SERVERS_HUB_NODE_ID ||
        node.id === ADD_SERVER_NODE_ID ||
        node.id.startsWith("server-card:");
      if (!shouldShift) return node;
      return {
        ...node,
        position: { x: node.position.x, y: node.position.y + dy },
      };
    });
  }, [filteredNodes, dy]);

  const shiftedEdges = useMemo(
    () => shiftReflowedBranchEdges(filteredEdges, dy),
    [filteredEdges, dy],
  );

  const nodes = useMemo(
    () =>
      shiftedNodes.map((node) =>
        node.type === "redesignAddServer" || node.type === "redesignHostMatrix"
          ? node
          : {
              ...node,
              selected: readOnly ? false : node.id === selectedNodeId,
            },
      ),
    [shiftedNodes, selectedNodeId, readOnly],
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
            reportMatrixHeight,
          }
        : { selectedNodeId, onSelectNode, reportMatrixHeight, onOpenComputer },
    [
      selectedNodeId,
      onSelectNode,
      readOnly,
      onRequestEdit,
      reportMatrixHeight,
      onOpenComputer,
    ],
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
      className="host-redesign-canvas relative h-full w-full overflow-hidden rounded-[28px] border border-border/70 bg-background"
      style={shellStyle}
      data-edges-ready={edgesReady ? "true" : "false"}
      data-viewport-ready={viewportReady ? "true" : "false"}
    >
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
          edges={shiftedEdges}
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
            color="oklch(0.55 0.02 250 / 0.22)"
            patternClassName="opacity-[0.45]"
          />
          <Controls
            showInteractive={false}
            className="!rounded-xl !border !border-border/70 !bg-card/95"
          />
        </ReactFlow>
        </div>
      </HostMatrixContext.Provider>
    </div>
  );
}

export type { HostRedesignViewModel };
