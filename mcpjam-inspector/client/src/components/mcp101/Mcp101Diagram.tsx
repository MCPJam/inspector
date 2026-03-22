import { memo, useMemo, useCallback } from "react";
import {
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Wrench,
  Database,
  MessageSquare,
  Monitor,
  Cable,
  Server,
  Shield,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Mcp101Step } from "./mcp101-guide-data";

// ---------------------------------------------------------------------------
// Node data
// ---------------------------------------------------------------------------

interface Mcp101NodeData extends Record<string, unknown> {
  label: string;
  sublabel?: string;
  variant: "host" | "client" | "server" | "primitive";
  highlighted: boolean;
  accentColor: string;
  iconName?: "wrench" | "database" | "message" | "monitor" | "cable" | "server";
  width: number;
  height: number;
  stepId?: string;
}

const ICON_MAP = {
  wrench: Wrench,
  database: Database,
  message: MessageSquare,
  monitor: Monitor,
  cable: Cable,
  server: Server,
} as const;

// ---------------------------------------------------------------------------
// Custom node component
// ---------------------------------------------------------------------------

const Mcp101BoxNode = memo((props: NodeProps<Node<Mcp101NodeData>>) => {
  const { data } = props;
  const Icon = data.iconName && data.iconName in ICON_MAP
    ? ICON_MAP[data.iconName as keyof typeof ICON_MAP]
    : null;

  const isContainer = data.variant === "host";

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center transition-all duration-500",
        isContainer
          ? "rounded-xl border-2 border-dashed"
          : "rounded-lg border-2",
        data.highlighted ? "bg-card shadow-lg" : "bg-card/50 opacity-40",
      )}
      style={{
        width: data.width,
        height: data.height,
        borderColor: data.highlighted ? data.accentColor : "var(--border)",
        boxShadow: data.highlighted
          ? `0 0 24px ${data.accentColor}15`
          : undefined,
      }}
    >
      {/* Top handle */}
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-transparent !border-0 !w-0 !h-0"
      />

      {Icon && (
        <Icon
          className="h-4 w-4 mb-1"
          style={{ color: data.highlighted ? data.accentColor : "var(--muted-foreground)" }}
        />
      )}
      <span
        className={cn(
          "font-semibold text-center leading-tight",
          data.variant === "primitive" ? "text-[11px]" : "text-xs",
        )}
      >
        {data.label}
      </span>
      {data.sublabel && (
        <span className="text-[10px] text-muted-foreground mt-0.5">
          {data.sublabel}
        </span>
      )}

      {/* Bottom handle */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
    </div>
  );
});

Mcp101BoxNode.displayName = "Mcp101BoxNode";

// ---------------------------------------------------------------------------
// Node type registry
// ---------------------------------------------------------------------------

const nodeTypes = { mcp101Box: Mcp101BoxNode };

// ---------------------------------------------------------------------------
// Static node definitions (positions and base data)
// ---------------------------------------------------------------------------

interface NodeDef {
  id: string;
  x: number;
  y: number;
  data: Omit<Mcp101NodeData, "highlighted">;
}

const NODE_DEFS: NodeDef[] = [
  {
    id: "host",
    x: 120,
    y: 10,
    data: {
      label: "Host Application",
      sublabel: "IDE, Chat, AI Workflow",
      variant: "host",
      accentColor: "#64748b",
      iconName: "monitor",
      width: 210,
      height: 80,
      stepId: "architecture",
    },
  },
  {
    id: "client",
    x: 150,
    y: 130,
    data: {
      label: "MCP Client",
      sublabel: "Protocol Connector",
      variant: "client",
      accentColor: "#3b82f6",
      iconName: "cable",
      width: 150,
      height: 65,
      stepId: "architecture",
    },
  },
  {
    id: "server",
    x: 150,
    y: 340,
    data: {
      label: "MCP Server",
      sublabel: "Tool Provider",
      variant: "server",
      accentColor: "#10b981",
      iconName: "server",
      width: 150,
      height: 65,
      stepId: "architecture",
    },
  },
  {
    id: "tools",
    x: 40,
    y: 460,
    data: {
      label: "Tools",
      sublabel: "AI-controlled",
      variant: "primitive",
      accentColor: "#f97316",
      iconName: "wrench",
      width: 110,
      height: 58,
      stepId: "capabilities",
    },
  },
  {
    id: "resources",
    x: 170,
    y: 460,
    data: {
      label: "Resources",
      sublabel: "App-controlled",
      variant: "primitive",
      accentColor: "#8b5cf6",
      iconName: "database",
      width: 110,
      height: 58,
      stepId: "capabilities",
    },
  },
  {
    id: "prompts",
    x: 300,
    y: 460,
    data: {
      label: "Prompts",
      sublabel: "User-controlled",
      variant: "primitive",
      accentColor: "#06b6d4",
      iconName: "message",
      width: 110,
      height: 58,
      stepId: "capabilities",
    },
  },
];

// ---------------------------------------------------------------------------
// Static edge definitions
// ---------------------------------------------------------------------------

interface EdgeDef {
  id: string;
  source: string;
  target: string;
  label?: string;
  stepId?: string;
}

const EDGE_DEFS: EdgeDef[] = [
  {
    id: "e-host-client",
    source: "host",
    target: "client",
  },
  {
    id: "e-client-server",
    source: "client",
    target: "server",
    label: "MCP Protocol",
    stepId: "what_is_mcp",
  },
  {
    id: "e-server-tools",
    source: "server",
    target: "tools",
    stepId: "capabilities",
  },
  {
    id: "e-server-resources",
    source: "server",
    target: "resources",
    stepId: "capabilities",
  },
  {
    id: "e-server-prompts",
    source: "server",
    target: "prompts",
    stepId: "capabilities",
  },
];

// ---------------------------------------------------------------------------
// Step-based highlighting
// ---------------------------------------------------------------------------

type HighlightMap = Record<string, boolean>;

function getNodeHighlights(step: Mcp101Step | undefined): HighlightMap {
  const all = { host: true, client: true, server: true, tools: true, resources: true, prompts: true };
  const none = { host: false, client: false, server: false, tools: false, resources: false, prompts: false };

  switch (step) {
    case "what_is_mcp":
      return all;
    case "why_standards":
      return all;
    case "architecture":
      return { ...none, host: true, client: true, server: true };
    case "capabilities":
      return { ...none, server: true, tools: true, resources: true, prompts: true };
    case "security":
      return all;
    default:
      return all;
  }
}

type EdgeHighlight = { color: string; width: number; animated: boolean; opacity: number };

function getEdgeHighlight(
  edgeId: string,
  step: Mcp101Step | undefined,
): EdgeHighlight {
  const neutral: EdgeHighlight = { color: "#94a3b8", width: 1.5, animated: false, opacity: 0.6 };
  const active: EdgeHighlight = { color: "#3b82f6", width: 2.5, animated: true, opacity: 1 };
  const visible: EdgeHighlight = { color: "#64748b", width: 1.5, animated: false, opacity: 1 };

  switch (step) {
    case "what_is_mcp":
      return edgeId === "e-client-server" ? active : visible;
    case "why_standards":
      return { ...active, color: "#10b981" };
    case "architecture":
      if (edgeId === "e-host-client" || edgeId === "e-client-server") return active;
      return neutral;
    case "capabilities":
      if (edgeId.startsWith("e-server-")) return { ...active, color: "#10b981" };
      return neutral;
    case "security":
      return edgeId === "e-client-server"
        ? { color: "#f59e0b", width: 3, animated: true, opacity: 1 }
        : visible;
    default:
      return visible;
  }
}

// ---------------------------------------------------------------------------
// Build ReactFlow nodes and edges
// ---------------------------------------------------------------------------

function buildDiagram(activeStep: Mcp101Step | undefined) {
  const highlights = getNodeHighlights(activeStep);

  const nodes: Node[] = NODE_DEFS.map((def) => ({
    id: def.id,
    type: "mcp101Box",
    position: { x: def.x, y: def.y },
    data: {
      ...def.data,
      highlighted: highlights[def.id] ?? true,
    },
    draggable: false,
  }));

  const edges: Edge[] = EDGE_DEFS.map((def) => {
    const h = getEdgeHighlight(def.id, activeStep);
    const isProtocolEdge = def.id === "e-client-server";
    const isSecurityStep = activeStep === "security";

    return {
      id: def.id,
      source: def.source,
      target: def.target,
      type: "default",
      animated: h.animated,
      label:
        isProtocolEdge && isSecurityStep
          ? "MCP Protocol \uD83D\uDD12"
          : def.label,
      labelStyle: {
        fontSize: 11,
        fontWeight: 600,
        fill: h.color,
      },
      labelBgStyle: {
        fill: "var(--card)",
        stroke: h.color,
        strokeWidth: h.animated ? 1.5 : 0.5,
        rx: 6,
        ry: 6,
      },
      labelBgPadding: [8, 4] as [number, number],
      data: { stepId: def.stepId },
      markerEnd: {
        type: "arrowclosed" as const,
        color: h.color,
        width: 10,
        height: 10,
      },
      style: {
        stroke: h.color,
        strokeWidth: h.width,
        opacity: h.opacity,
      },
    };
  });

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Security badge overlay — floating shield shown during security step
// ---------------------------------------------------------------------------

function SecurityBadge({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div
      className="absolute top-4 right-4 z-10 flex items-center gap-1.5 rounded-full border border-amber-300/60 bg-amber-50/90 dark:bg-amber-950/50 dark:border-amber-700/40 px-3 py-1.5 shadow-sm transition-all duration-500"
      style={{ opacity: visible ? 1 : 0 }}
    >
      <Shield className="h-3.5 w-3.5 text-amber-500" />
      <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider">
        User consent required
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inner diagram (needs ReactFlowProvider above it)
// ---------------------------------------------------------------------------

function Mcp101DiagramInner({
  activeStep,
  onStepClick,
}: {
  activeStep: Mcp101Step | undefined;
  onStepClick?: (stepId: string) => void;
}) {
  const { nodes, edges } = useMemo(() => buildDiagram(activeStep), [activeStep]);

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const stepId = (node.data as Mcp101NodeData)?.stepId;
      if (stepId && onStepClick) onStepClick(stepId);
    },
    [onStepClick],
  );

  const handleEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      const stepId = edge.data?.stepId as string | undefined;
      if (stepId && onStepClick) onStepClick(stepId);
    },
    [onStepClick],
  );

  return (
    <div className="relative w-full h-full">
      <SecurityBadge visible={activeStep === "security"} />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.5}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        panOnScroll={true}
        zoomOnScroll={true}
        zoomOnPinch={true}
        panOnDrag={true}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface Mcp101DiagramProps {
  activeStep: Mcp101Step | undefined;
  onStepClick?: (stepId: string) => void;
}

export function Mcp101Diagram({ activeStep, onStepClick }: Mcp101DiagramProps) {
  return (
    <ReactFlowProvider>
      <Mcp101DiagramInner activeStep={activeStep} onStepClick={onStepClick} />
    </ReactFlowProvider>
  );
}
