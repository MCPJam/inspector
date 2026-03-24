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
  "host-group",
  "llm-app",
  "mcp-client",
  "server-tools",
  "server-resources",
  "server-prompts",
  "tools",
  "resources",
  "prompts",
];

const ALL_EDGES = [
  "e-llm-client",
  "e-client-server-tools",
  "e-client-server-resources",
  "e-client-server-prompts",
  "e-server-tools",
  "e-server-resources",
  "e-server-prompts",
];

export const STEP_HIGHLIGHTS: Record<WhatIsMcpStep, StepHighlightMap> = {
  intro: {
    activeNodes: ALL_NODES,
    activeEdges: ALL_EDGES,
  },
  host_app: {
    activeNodes: ["host-group", "llm-app"],
    activeEdges: [],
  },
  mcp_client: {
    activeNodes: ["mcp-client"],
    activeEdges: ["e-llm-client"],
  },
  mcp_servers: {
    activeNodes: ["server-tools", "server-resources", "server-prompts"],
    activeEdges: [
      "e-client-server-tools",
      "e-client-server-resources",
      "e-client-server-prompts",
    ],
  },
  tools: {
    activeNodes: ["tools"],
    activeEdges: ["e-server-tools"],
  },
  resources: {
    activeNodes: ["resources"],
    activeEdges: ["e-server-resources"],
  },
  prompts: {
    activeNodes: ["prompts"],
    activeEdges: ["e-server-prompts"],
  },
  ecosystem: {
    activeNodes: ALL_NODES,
    activeEdges: ALL_EDGES,
  },
};

// ---------------------------------------------------------------------------
// Architecture diagram data — matches internal MCP architecture from guide
// ---------------------------------------------------------------------------

const NODES: ArchNodeDef[] = [
  // Host Application group
  {
    id: "host-group",
    label: "Host Application",
    subtitle: "Claude Desktop, Cursor, VS Code, etc.",
    type: "group",
    color: "#6366f1", // indigo
    position: { x: 0, y: 0 },
    width: 420,
    height: 160,
  },

  // Inside host
  {
    id: "llm-app",
    label: "LLM / AI Engine",
    subtitle: "Language model",
    icon: "🧠",
    type: "block",
    color: "#8b5cf6", // purple
    position: { x: 30, y: 55 },
    parentId: "host-group",
  },
  {
    id: "mcp-client",
    label: "MCP Client",
    subtitle: "Protocol bridge",
    icon: "🔌",
    type: "block",
    color: "#3b82f6", // blue
    position: { x: 230, y: 55 },
    parentId: "host-group",
  },

  // MCP Servers (outside host, to the right)
  {
    id: "server-tools",
    label: "MCP Server",
    subtitle: "Tool provider",
    icon: "⚙️",
    type: "block",
    color: "#f59e0b", // amber
    position: { x: 530, y: 0 },
  },
  {
    id: "server-resources",
    label: "MCP Server",
    subtitle: "Data provider",
    icon: "⚙️",
    type: "block",
    color: "#f59e0b",
    position: { x: 530, y: 110 },
  },
  {
    id: "server-prompts",
    label: "MCP Server",
    subtitle: "Prompt provider",
    icon: "⚙️",
    type: "block",
    color: "#f59e0b",
    position: { x: 530, y: 220 },
  },

  // Capabilities (rightmost column)
  {
    id: "tools",
    label: "Tools",
    subtitle: "APIs, functions, actions",
    icon: "🔧",
    type: "block",
    color: "#10b981", // green
    position: { x: 780, y: 0 },
  },
  {
    id: "resources",
    label: "Resources",
    subtitle: "Files, databases, data",
    icon: "📦",
    type: "block",
    color: "#10b981",
    position: { x: 780, y: 110 },
  },
  {
    id: "prompts",
    label: "Prompts",
    subtitle: "Templates, workflows",
    icon: "📝",
    type: "block",
    color: "#10b981",
    position: { x: 780, y: 220 },
  },
];

const EDGES: ArchEdgeDef[] = [
  // LLM ↔ MCP Client (inside host)
  {
    id: "e-llm-client",
    source: "llm-app",
    target: "mcp-client",
  },

  // MCP Client → Servers (via MCP Protocol)
  {
    id: "e-client-server-tools",
    source: "mcp-client",
    target: "server-tools",
    label: "MCP Protocol",
  },
  {
    id: "e-client-server-resources",
    source: "mcp-client",
    target: "server-resources",
  },
  {
    id: "e-client-server-prompts",
    source: "mcp-client",
    target: "server-prompts",
  },

  // Servers → Capabilities
  {
    id: "e-server-tools",
    source: "server-tools",
    target: "tools",
  },
  {
    id: "e-server-resources",
    source: "server-resources",
    target: "resources",
  },
  {
    id: "e-server-prompts",
    source: "server-prompts",
    target: "prompts",
  },
];

export function buildWhatIsMcpScenario(): ArchDiagramScenario {
  return { nodes: NODES, edges: EDGES };
}
