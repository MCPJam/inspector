import { memo, useMemo, type CSSProperties } from "react";
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
import {
  AppWindow,
  Plug,
  Plus,
  Server,
  SlidersHorizontal,
} from "lucide-react";
import "@xyflow/react/dist/style.css";
import { cn } from "@/lib/utils";
import {
  type AddServerPillNodeData,
  type AgentIdentityNodeData,
  type AppsCapLeafNodeData,
  type HostGroupNodeData,
  type HostRedesignViewModel,
  type ProtocolLeafNodeData,
  type SectionHubNodeData,
  type ServerCardNodeData,
  type ServersHubNodeData,
} from "../types";

const WARNING_COLOR = "oklch(0.5 0.13 70)";

/* ============================================================
   Field rendering primitives — used by the agent identity card.
   ============================================================ */
function FieldRow({
  label,
  value,
  mono,
  attention,
  changed,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  attention?: boolean;
  changed?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline gap-2 py-[3px] text-[11.5px] leading-tight",
        // Per-field diff flash. Triggered when changed flips true; the
        // animation plays once via CSS keyframes on mount/data change.
        changed && "host-redesign-field-flash",
      )}
    >
      <span className="w-[92px] shrink-0 text-[10.5px] uppercase tracking-[0.04em] text-muted-foreground/80">
        {label}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          mono && "font-mono",
          attention && "font-semibold",
        )}
        style={attention ? { color: WARNING_COLOR } : undefined}
        title={typeof value === "string" ? value : undefined}
      >
        {value}
      </span>
    </div>
  );
}

function ProviderGlyph({ provider }: { provider: string | null }) {
  if (!provider) {
    return (
      <span className="inline-flex size-[26px] items-center justify-center rounded-md border border-border/60 bg-muted/40 text-[10px] font-semibold uppercase text-muted-foreground">
        ?
      </span>
    );
  }
  const letter = provider.charAt(0).toUpperCase();
  return (
    <span className="inline-flex size-[26px] items-center justify-center rounded-md bg-foreground/90 text-[12px] font-semibold uppercase text-background">
      {letter}
    </span>
  );
}

const decorativeHandleClass = "!opacity-0 !w-2 !h-2";

/* ============================================================
   Host group — the dashed parent. Empty render; just paints the
   container and floats the host name strip on top. Its size is
   data-driven from the builder so each host's silhouette differs.
   ============================================================ */
const HostGroupNodeRenderer = memo(
  (props: NodeProps<Node<HostGroupNodeData, "redesignHostGroup">>) => {
    const { data } = props;
    return (
      <div
        className="relative h-full w-full rounded-[16px] border-2 border-dashed"
        style={{
          borderColor: "color-mix(in oklch, var(--primary) 50%, transparent)",
          backgroundColor:
            "color-mix(in oklch, var(--primary) 3.5%, transparent)",
        }}
      >
        <span
          className="pointer-events-none absolute left-3.5 top-2 block max-w-[min(840px,calc(100%-1.75rem))] truncate text-[13px] font-semibold leading-tight tracking-tight text-foreground"
          title={data.hostName}
        >
          {data.hostName}
        </span>
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
HostGroupNodeRenderer.displayName = "HostGroupNodeRenderer";

/* ============================================================
   Agent identity — portrait card with prominent model badge.
   This is the host's "operator identity" and stays a single
   card because its fields form a portrait, not a list.
   ============================================================ */
const AgentIdentityRenderer = memo(
  (props: NodeProps<Node<AgentIdentityNodeData, "redesignAgentIdentity">>) => {
    const { data, selected } = props;
    const attention = new Set(data.attentionFields);
    const changed = new Set(data.changedFields);
    const modelChanged = changed.has("modelId");
    return (
      <div
        className={cn(
          "group flex w-full flex-col overflow-hidden rounded-[12px] bg-background shadow-sm transition-all hover:shadow-md",
          "border-[1.5px]",
          selected && "ring-2 ring-primary/45",
        )}
        style={{
          borderColor: "color-mix(in oklch, var(--primary) 55%, transparent)",
        }}
      >
        <div className="flex items-center gap-2.5 rounded-t-[10px] border-b border-border/60 bg-muted/25 px-3 py-2.5">
          <div className="flex size-6 items-center justify-center rounded-md bg-muted/50 text-muted-foreground">
            <SlidersHorizontal className="size-3" />
          </div>
          <div className="flex min-w-0 flex-col justify-center">
            <span className="truncate text-[13px] font-semibold leading-tight text-foreground">
              Agent
            </span>
          </div>
          <span
            className="ml-auto size-1.5 rounded-full"
            style={{
              backgroundColor:
                "color-mix(in oklch, var(--primary) 80%, transparent)",
              boxShadow:
                "0 0 8px color-mix(in oklch, var(--primary) 60%, transparent)",
            }}
            aria-hidden
          />
        </div>
        <div className="flex flex-col px-3 pb-3 pt-2">
          {/* Model row — the visual hero of the identity card. The
              provider letter glyph + monospace model name makes the
              host's "engine" the dominant cue, with the rest of the
              fields living as supporting context below. */}
          <div
            className={cn(
              "flex items-center gap-2 border-b border-dashed border-border/60 pb-2.5 pt-1.5",
              modelChanged && "host-redesign-field-flash",
            )}
          >
            <ProviderGlyph provider={data.modelProvider} />
            <span
              className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-medium"
              title={data.modelLabel}
            >
              {data.modelLabel}
            </span>
          </div>
          <div className="mt-1.5 flex flex-col">
            <FieldRow
              label="Temperature"
              value={data.temperature.toFixed(2)}
              mono
              changed={changed.has("temperature")}
            />
            <FieldRow
              label="Host style"
              value={data.hostStyleLabel}
              changed={changed.has("hostStyle")}
            />
            <FieldRow
              label="Tool approval"
              value={data.toolApproval ? "on" : "off"}
              changed={changed.has("toolApproval")}
            />
            <FieldRow
              label="System prompt"
              value={data.systemPromptEmpty ? "(empty)" : "configured"}
              attention={attention.has("systemPrompt")}
              changed={changed.has("systemPrompt")}
            />
          </div>
        </div>
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
AgentIdentityRenderer.displayName = "AgentIdentityRenderer";

/* ============================================================
   Section hub — small puck for Protocol + Apps. Icon differs
   per section; subtitle changes per host (e.g. "SDK defaults · 11
   ctx fields" vs "pinned 2026-01-26 · 5 ctx fields"). The
   subtitle change is the at-a-glance cue for section drift.
   ============================================================ */
const SectionHubRenderer = memo(
  (props: NodeProps<Node<SectionHubNodeData, "redesignSectionHub">>) => {
    const { data, selected } = props;
    const Icon = data.section === "protocol" ? Plug : AppWindow;
    return (
      <div
        className={cn(
          "flex h-full w-full items-center gap-3 rounded-[10px] border border-border/70 bg-card/95 px-3 shadow-sm transition-all hover:shadow-md",
          selected && "ring-2 ring-primary/40",
          data.hasAttention && "border-amber-500/60",
        )}
      >
        <div
          className={cn(
            "flex size-7 items-center justify-center rounded-md bg-muted/60",
            data.section === "protocol"
              ? "text-sky-400/90"
              : "text-amber-400/90",
          )}
        >
          <Icon className="size-3.5" />
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[12.5px] font-semibold leading-tight">
            {data.title}
          </span>
          <span
            className={cn(
              "truncate font-mono text-[10px] leading-tight text-muted-foreground",
              data.subtitleChanged && "host-redesign-subtitle-flash",
            )}
            title={data.subtitle}
          >
            {data.subtitle}
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
          position={Position.Right}
          id="right"
          className={decorativeHandleClass}
        />
      </div>
    );
  },
);
SectionHubRenderer.displayName = "SectionHubRenderer";

/* ============================================================
   Protocol leaf — uppercase label + monospace value.
   ============================================================ */
const ProtocolLeafRenderer = memo(
  (props: NodeProps<Node<ProtocolLeafNodeData, "redesignProtocolLeaf">>) => {
    const { data, selected } = props;
    return (
      <div
        className={cn(
          "flex h-full w-full flex-col justify-center gap-[1px] rounded-[8px] border border-border/60 bg-card/95 px-2.5 py-1 shadow-sm transition-colors",
          selected && "ring-2 ring-primary/40",
          data.hasAttention && "border-amber-500/60",
          data.isChanged && "host-redesign-leaf-flash",
        )}
      >
        <span className="text-[9px] uppercase leading-tight tracking-[0.08em] text-muted-foreground">
          {data.label}
        </span>
        <span
          className="truncate font-mono text-[11px] font-medium leading-tight"
          title={data.value}
        >
          {data.value}
        </span>
        <Handle
          type="target"
          position={Position.Left}
          id="left"
          className={decorativeHandleClass}
        />
      </div>
    );
  },
);
ProtocolLeafRenderer.displayName = "ProtocolLeafRenderer";

/* ============================================================
   Apps cap leaf — dot + monospace capability name + qualifier.
   Off-state renders as dimmed + struck-through so the *absence*
   of a cap is visually load-bearing.
   ============================================================ */
const AppsCapLeafRenderer = memo(
  (props: NodeProps<Node<AppsCapLeafNodeData, "redesignAppsCapLeaf">>) => {
    const { data, selected } = props;
    return (
      <div
        className={cn(
          "group flex h-full w-full items-center gap-2 rounded-[8px] border border-border/60 bg-card/95 px-2.5 py-1 shadow-sm transition-colors",
          selected && "ring-2 ring-primary/40",
          !data.on && "opacity-60",
          data.isChanged && "host-redesign-leaf-flash",
          data.isNewlyOn && "host-redesign-leaf-newly-on",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "size-[7px] shrink-0 rounded-full",
            data.on ? "bg-emerald-400" : "bg-muted-foreground/40",
          )}
          style={
            data.on
              ? { boxShadow: "0 0 6px color-mix(in oklch, currentColor 60%, transparent)" }
              : undefined
          }
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-[11px] font-medium leading-tight",
            !data.on && "text-muted-foreground line-through",
          )}
          title={data.label}
        >
          {data.label}
        </span>
        {data.qualifier ? (
          <span className="shrink-0 rounded-[3px] bg-white/[0.04] px-1 py-[1px] font-mono text-[9px] text-muted-foreground">
            {data.qualifier}
          </span>
        ) : null}
        <Handle
          type="target"
          position={Position.Left}
          id="left"
          className={decorativeHandleClass}
        />
      </div>
    );
  },
);
AppsCapLeafRenderer.displayName = "AppsCapLeafRenderer";

/* ============================================================
   Servers hub + cards + add-server pill — unchanged from the
   previous design; their geometry already responded to server
   count, which the redesign keeps.
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

const ServerCardNodeRenderer = memo(
  (props: NodeProps<Node<ServerCardNodeData, "redesignServerCard">>) => {
    const { data, selected } = props;
    return (
      <div
        className={cn(
          "flex h-full w-full flex-col gap-1 rounded-[8px] border border-border/70 bg-card/95 px-3 py-2 shadow-sm transition-all hover:shadow-md",
          selected && "ring-2 ring-primary/40",
        )}
      >
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "size-1.5 rounded-full",
              data.insecure ? "bg-amber-500" : "bg-emerald-500",
            )}
            aria-hidden
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
  redesignHostGroup: HostGroupNodeRenderer,
  redesignAgentIdentity: AgentIdentityRenderer,
  redesignSectionHub: SectionHubRenderer,
  redesignProtocolLeaf: ProtocolLeafRenderer,
  redesignAppsCapLeaf: AppsCapLeafRenderer,
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
  /**
   * Brand shell tokens for the active host style. Cascades brand
   * `--background` / `--foreground` / `--card` / `--border` etc. into the
   * subtree so descendants using design-system tokens (`bg-background`,
   * `text-foreground`, `bg-muted`, `border-border`, …) repaint to brand
   * automatically. Falls back to default theme tokens when omitted.
   */
  shellStyle?: CSSProperties;
}

/**
 * Inline CSS — keeps the diff/morph animation contract co-located
 * with the renderers that depend on it. Scoped to `.host-redesign-canvas`
 * so the `.react-flow__node` transform transition doesn't leak into
 * other canvases on the same page.
 */
const CANVAS_STYLES = `
.host-redesign-canvas .react-flow__node {
  transition: transform 520ms cubic-bezier(0.32, 0.72, 0, 1);
}
.host-redesign-canvas .react-flow__edge-path {
  transition: stroke 360ms ease, stroke-width 360ms ease,
              stroke-dasharray 360ms ease, d 520ms cubic-bezier(0.32, 0.72, 0, 1);
}
@keyframes hostRedesignDiffFlash {
  0% { background-color: oklch(0.78 0.17 75 / 0.28); box-shadow: inset 2px 0 0 oklch(0.78 0.17 75); }
  60% { background-color: oklch(0.78 0.17 75 / 0.10); box-shadow: inset 2px 0 0 oklch(0.78 0.17 75); }
  100% { background-color: transparent; box-shadow: inset 2px 0 0 transparent; }
}
.host-redesign-field-flash {
  animation: hostRedesignDiffFlash 1.5s ease-out;
  border-radius: 4px;
}
.host-redesign-leaf-flash {
  animation: hostRedesignDiffFlash 1.5s ease-out;
}
.host-redesign-subtitle-flash {
  color: oklch(0.78 0.17 75) !important;
  animation: hostRedesignSubtitleFade 1.5s ease-out forwards;
}
@keyframes hostRedesignSubtitleFade {
  0% { color: oklch(0.78 0.17 75); }
  100% { color: var(--muted-foreground, oklch(0.58 0.012 100)); }
}
.host-redesign-leaf-newly-on {
  box-shadow: 0 0 0 1px oklch(0.78 0.17 75 / 0.55),
              0 0 16px -4px oklch(0.78 0.17 75 / 0.6);
  animation: hostRedesignNewlyOn 1.5s ease-out;
}
@keyframes hostRedesignNewlyOn {
  0% {
    box-shadow: 0 0 0 1px oklch(0.78 0.17 75 / 0.75),
                0 0 24px -4px oklch(0.78 0.17 75 / 0.7);
  }
  100% {
    box-shadow: 0 0 0 1px transparent, 0 0 0 0 transparent;
  }
}
`;

export function RedesignedHostCanvas({
  viewModel,
  selectedNodeId,
  onSelectNode,
  onClearSelection,
  onAddServer,
  shellStyle,
}: RedesignedHostCanvasProps) {
  const nodes = useMemo(
    () =>
      viewModel.nodes.map((node) =>
        node.type === "redesignHostGroup" ||
        node.type === "redesignAddServer"
          ? node
          : { ...node, selected: node.id === selectedNodeId },
      ),
    [viewModel.nodes, selectedNodeId],
  );

  return (
    <div
      className="host-redesign-canvas relative h-full w-full overflow-hidden rounded-[28px] border border-border/70 bg-background"
      style={shellStyle}
    >
      <style>{CANVAS_STYLES}</style>
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
        fitViewOptions={{ padding: 0.18 }}
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
  );
}

export type { HostRedesignViewModel };
