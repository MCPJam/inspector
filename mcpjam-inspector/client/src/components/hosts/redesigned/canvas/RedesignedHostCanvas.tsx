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
import { AppWindow, Plug, Plus, Server, SlidersHorizontal } from "lucide-react";
import "@xyflow/react/dist/style.css";
import { cn } from "@/lib/utils";
import {
  type AddServerPillNodeData,
  type AppsExtensionSubNodeData,
  type BehaviorSubNodeData,
  type HostGroupNodeData,
  type HostRedesignViewModel,
  type ProtocolSubNodeData,
  type ServerCardNodeData,
  type ServersHubNodeData,
} from "../types";

const WARNING_COLOR = "oklch(0.5 0.13 70)";

function FieldRow({
  label,
  value,
  mono,
  attention,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  attention?: boolean;
  accent?: "primary" | "info" | "neutral";
}) {
  return (
    <div className="flex items-baseline gap-2 py-[3px] text-[11.5px] leading-tight">
      <span
        className={cn(
          "w-[92px] shrink-0 text-[10.5px] uppercase tracking-[0.04em] text-muted-foreground/80",
          accent === "primary" && "text-primary/70",
          accent === "info" && "text-sky-700/80 dark:text-sky-300/80",
        )}
      >
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

function SubNodeHeader({
  icon,
  title,
  eyebrow,
}: {
  icon: React.ReactNode;
  title: string;
  eyebrow?: string;
}) {
  const compact = eyebrow === undefined;
  return (
    <div
      className={cn(
        "flex items-center rounded-t-[10px] border-b border-border/60 px-3 bg-muted/25",
        compact ? "gap-2 py-2" : "gap-2.5 py-2.5",
      )}
    >
      <div
        className={cn(
          "flex items-center justify-center rounded-md bg-muted/50 text-muted-foreground",
          compact ? "size-5" : "size-6",
        )}
      >
        {icon}
      </div>
      <div className="flex min-w-0 flex-col justify-center">
        <span
          className={cn(
            "truncate leading-tight text-foreground",
            compact
              ? "text-[12.5px] font-medium"
              : "text-[13px] font-semibold",
          )}
        >
          {title}
        </span>
        {eyebrow ? (
          <span className="truncate text-[10px] font-semibold uppercase tracking-[0.04em] text-muted-foreground/80">
            {eyebrow}
          </span>
        ) : null}
      </div>
    </div>
  );
}

const subNodeShellClass =
  "host-redesign-subnode group flex w-[268px] flex-col overflow-hidden rounded-[10px] bg-background shadow-sm transition-all hover:shadow-md";

const decorativeHandleClass = "!opacity-0 !w-2 !h-2";

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

function ProviderGlyph({ provider }: { provider: string | null }) {
  if (!provider) {
    return (
      <span className="inline-flex size-4 items-center justify-center rounded-sm border border-border/60 bg-muted/40 text-[8px] font-semibold uppercase text-muted-foreground">
        ?
      </span>
    );
  }
  const letter = provider.charAt(0).toUpperCase();
  return (
    <span className="inline-flex size-4 items-center justify-center rounded-sm bg-foreground/85 text-[9px] font-semibold uppercase text-background">
      {letter}
    </span>
  );
}

const BehaviorSubNodeRenderer = memo(
  (props: NodeProps<Node<BehaviorSubNodeData, "redesignBehavior">>) => {
    const { data, selected } = props;
    const attention = new Set(data.attentionFields);
    return (
      <div
        className={cn(
          subNodeShellClass,
          "border-[1.5px]",
          selected && "ring-2 ring-primary/45",
        )}
        style={{
          borderColor:
            "color-mix(in oklch, var(--primary) 55%, transparent)",
        }}
      >
        <SubNodeHeader
          icon={<SlidersHorizontal className="size-3" />}
          title="Agent"
        />
        <div className="flex flex-col px-3 py-2">
          <FieldRow
            label="Model"
            value={
              <span className="inline-flex items-center gap-1.5">
                <ProviderGlyph provider={data.modelProvider} />
                <span className="font-mono">{data.modelLabel}</span>
              </span>
            }
            attention={attention.has("modelId")}
          />
          <FieldRow
            label="Temperature"
            value={data.temperature.toFixed(2)}
            mono
          />
          <FieldRow label="Host style" value={data.hostStyleLabel} />
          <FieldRow
            label="Tool approval"
            value={data.toolApproval ? "on" : "off"}
          />
          <FieldRow
            label="System prompt"
            value={data.systemPromptEmpty ? "(empty)" : "configured"}
            attention={attention.has("systemPrompt")}
          />
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
BehaviorSubNodeRenderer.displayName = "BehaviorSubNodeRenderer";

const ProtocolSubNodeRenderer = memo(
  (props: NodeProps<Node<ProtocolSubNodeData, "redesignProtocol">>) => {
    const { data, selected } = props;
    const attention = new Set(data.attentionFields);
    return (
      <div
        className={cn(
          subNodeShellClass,
          "border border-border/70",
          selected && "ring-2 ring-primary/40",
        )}
      >
        <SubNodeHeader
          icon={<Plug className="size-3" />}
          title="MCP Protocol"
        />
        <div className="flex flex-col px-3 py-2">
          <FieldRow
            label="clientInfo"
            value={data.clientInfoSummary}
            mono
          />
          <FieldRow
            label="Protocol"
            value={data.protocolVersionsSummary}
            mono
          />
          <FieldRow
            label="Capabilities"
            value={data.capabilitiesSummary}
          />
          <FieldRow
            label="hostContext"
            value={
              <span className="font-mono text-muted-foreground">
                {data.hostContextSummary}
              </span>
            }
          />
          <FieldRow
            label="Timeout · headers"
            value={data.connectionSummary}
            mono
            attention={
              attention.has("requestTimeout") || attention.has("hostContext")
            }
          />
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
ProtocolSubNodeRenderer.displayName = "ProtocolSubNodeRenderer";

const AppsExtensionSubNodeRenderer = memo(
  (
    props: NodeProps<Node<AppsExtensionSubNodeData, "redesignApps">>,
  ) => {
    const { data, selected } = props;
    const attention = new Set(data.attentionFields);
    return (
      <div
        className={cn(
          subNodeShellClass,
          "border border-border/70",
          selected && "ring-2 ring-sky-400/50",
        )}
      >
        <SubNodeHeader
          icon={<AppWindow className="size-3" />}
          title="Apps Extension"
        />
        <div className="flex flex-col px-3 py-2">
          <FieldRow
            label="Enabled"
            value={
              <span className="inline-flex items-center gap-1.5">
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    data.enabled ? "bg-sky-500" : "bg-muted-foreground/40",
                  )}
                />
                <span className="font-mono">
                  {data.enabled ? data.mimeTypesSummary : "off"}
                </span>
              </span>
            }
            attention={attention.has("mimeTypes")}
          />
          <FieldRow
            label="Host caps"
            value={
              <span>
                {data.hostCapabilitiesCount} advertised
                {data.hasOverride ? (
                  <span className="ml-1 text-[10px] text-muted-foreground">
                    (override)
                  </span>
                ) : null}
              </span>
            }
          />
          <FieldRow
            label="Sandbox CSP"
            value={data.sandboxModeLabel}
            mono
          />
          <FieldRow
            label="openLinks · message"
            value={`${data.openLinksOn ? "on" : "off"} · ${data.messageOn ? "on" : "off"}`}
          />
          <FieldRow
            label="updateContext"
            value={data.updateModelContextLabel}
          />
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
AppsExtensionSubNodeRenderer.displayName = "AppsExtensionSubNodeRenderer";

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
  (
    _props: NodeProps<Node<AddServerPillNodeData, "redesignAddServer">>,
  ) => {
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
  redesignBehavior: BehaviorSubNodeRenderer,
  redesignProtocol: ProtocolSubNodeRenderer,
  redesignApps: AppsExtensionSubNodeRenderer,
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
}

export function RedesignedHostCanvas({
  viewModel,
  selectedNodeId,
  onSelectNode,
  onClearSelection,
  onAddServer,
}: RedesignedHostCanvasProps) {
  const nodes = useMemo(
    () =>
      viewModel.nodes.map((node) =>
        node.type === "redesignHostGroup" || node.type === "redesignAddServer"
          ? node
          : { ...node, selected: node.id === selectedNodeId },
      ),
    [viewModel.nodes, selectedNodeId],
  );

  return (
    <div className="relative h-full w-full overflow-hidden rounded-[28px] border border-border/70 bg-background">
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
