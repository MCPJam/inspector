import type {
  ArchNodeDef,
  ArchEdgeDef,
  ArchDiagramScenario,
  StepHighlightMap,
} from "@/components/architecture-diagram";

// ---------------------------------------------------------------------------
// Step definitions
// ---------------------------------------------------------------------------

export type WhatIsMcpStep =
  | "intro"
  | "host_app"
  | "mcp_client"
  | "mcp_servers"
  | "tools"
  | "resources"
  | "prompts"
  | "ecosystem";

export const WHAT_IS_MCP_STEP_ORDER: WhatIsMcpStep[] = [
  "intro",
  "host_app",
  "mcp_client",
  "mcp_servers",
  "tools",
  "resources",
  "prompts",
  "ecosystem",
];

// ---------------------------------------------------------------------------
// Highlight map — which nodes/edges are "active" at each step
// ---------------------------------------------------------------------------

const ALL_NODES = [
  "chat-interfaces",
  "ides",
  "other-ai-apps",
  "mcp-protocol",
  "data-filesystems",
  "dev-tools",
  "productivity-tools",
];

const LEFT_EDGES = [
  "e-chat-mcp",
  "e-ides-mcp",
  "e-other-mcp",
];

const RIGHT_EDGES = [
  "e-mcp-data",
  "e-mcp-dev",
  "e-mcp-prod",
];

const ALL_EDGES = [...LEFT_EDGES, ...RIGHT_EDGES];

export const STEP_HIGHLIGHTS: Record<WhatIsMcpStep, StepHighlightMap> = {
  intro: {
    activeNodes: ALL_NODES,
    activeEdges: ALL_EDGES,
  },
  host_app: {
    activeNodes: ["chat-interfaces", "ides", "other-ai-apps"],
    activeEdges: [],
  },
  mcp_client: {
    activeNodes: ["mcp-protocol"],
    activeEdges: LEFT_EDGES,
  },
  mcp_servers: {
    activeNodes: ["mcp-protocol"],
    activeEdges: RIGHT_EDGES,
  },
  tools: {
    activeNodes: ["dev-tools"],
    activeEdges: ["e-mcp-dev"],
  },
  resources: {
    activeNodes: ["data-filesystems"],
    activeEdges: ["e-mcp-data"],
  },
  prompts: {
    activeNodes: ["productivity-tools"],
    activeEdges: ["e-mcp-prod"],
  },
  ecosystem: {
    activeNodes: ALL_NODES,
    activeEdges: ALL_EDGES,
  },
};

// ---------------------------------------------------------------------------
// Architecture diagram data — hub-and-spoke layout matching MCP overview
// ---------------------------------------------------------------------------

// Layout: 3 left nodes → center MCP → 3 right nodes
const LEFT_X = 0;
const CENTER_X = 300;
const RIGHT_X = 600;
const ROW_SPACING = 110;
const TOP_Y = 0;

const NODES: ArchNodeDef[] = [
  // Left column — AI Applications (Host Applications)
  {
    id: "chat-interfaces",
    label: "Chat interface",
    subtitle: "Claude Desktop, LibreChat",
    icon: "💬",
    type: "block",
    color: "#8b5cf6", // purple
    position: { x: LEFT_X, y: TOP_Y },
  },
  {
    id: "ides",
    label: "IDEs and code editors",
    subtitle: "Claude Code, Goose",
    icon: "💻",
    type: "block",
    color: "#8b5cf6",
    position: { x: LEFT_X, y: TOP_Y + ROW_SPACING },
  },
  {
    id: "other-ai-apps",
    label: "Other AI applications",
    subtitle: "5ire, Superinterface",
    icon: "🤖",
    type: "block",
    color: "#8b5cf6",
    position: { x: LEFT_X, y: TOP_Y + ROW_SPACING * 2 },
  },

  // Center — MCP Protocol (larger block)
  {
    id: "mcp-protocol",
    label: "MCP",
    subtitle: "Standardized protocol",
    type: "block",
    color: "#3b82f6", // blue
    position: { x: CENTER_X, y: TOP_Y + 30 },
    width: 200,
    height: 160,
  },

  // Right column — Data Sources and Tools
  {
    id: "data-filesystems",
    label: "Data and file systems",
    subtitle: "PostgreSQL, SQLite, GDrive",
    icon: "🗄️",
    type: "block",
    color: "#10b981", // green
    position: { x: RIGHT_X, y: TOP_Y },
  },
  {
    id: "dev-tools",
    label: "Development tools",
    subtitle: "Git, Sentry, etc.",
    icon: "🔧",
    type: "block",
    color: "#10b981",
    position: { x: RIGHT_X, y: TOP_Y + ROW_SPACING },
  },
  {
    id: "productivity-tools",
    label: "Productivity tools",
    subtitle: "Slack, Google Maps, etc.",
    icon: "📋",
    type: "block",
    color: "#10b981",
    position: { x: RIGHT_X, y: TOP_Y + ROW_SPACING * 2 },
  },
];

const EDGES: ArchEdgeDef[] = [
  // Left → MCP (AI apps to protocol)
  {
    id: "e-chat-mcp",
    source: "chat-interfaces",
    target: "mcp-protocol",
    sourceHandle: "right",
    targetHandle: "left",
    bidirectional: true,
  },
  {
    id: "e-ides-mcp",
    source: "ides",
    target: "mcp-protocol",
    sourceHandle: "right",
    targetHandle: "left",
    bidirectional: true,
    label: "Bidirectional data flow",
  },
  {
    id: "e-other-mcp",
    source: "other-ai-apps",
    target: "mcp-protocol",
    sourceHandle: "right",
    targetHandle: "left",
    bidirectional: true,
  },

  // MCP → Right (protocol to data sources)
  {
    id: "e-mcp-data",
    source: "mcp-protocol",
    target: "data-filesystems",
    sourceHandle: "right",
    targetHandle: "left",
    bidirectional: true,
  },
  {
    id: "e-mcp-dev",
    source: "mcp-protocol",
    target: "dev-tools",
    sourceHandle: "right",
    targetHandle: "left",
    bidirectional: true,
    label: "Bidirectional data flow",
  },
  {
    id: "e-mcp-prod",
    source: "mcp-protocol",
    target: "productivity-tools",
    sourceHandle: "right",
    targetHandle: "left",
    bidirectional: true,
  },
];

export function buildWhatIsMcpScenario(): ArchDiagramScenario {
  return { nodes: NODES, edges: EDGES };
}
