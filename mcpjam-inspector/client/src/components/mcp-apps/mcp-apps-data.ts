import { AppWindow, Bot, FileCode, Wrench, Database } from "lucide-react";
import type {
  ArchNodeDef,
  ArchEdgeDef,
  ArchDiagramScenario,
  StepHighlightMap,
} from "@/components/architecture-diagram";

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export type McpAppsStep =
  | "intro"
  | "host_client"
  | "tool_definition"
  | "ui_resource"
  | "widget_component"
  | "iframe_view"
  | "lifecycle";

export const MCP_APPS_STEP_ORDER: McpAppsStep[] = [
  "intro",
  "host_client",
  "tool_definition",
  "ui_resource",
  "widget_component",
  "iframe_view",
  "lifecycle",
];

const ALL_NODES = [
  "host-group",
  "ai-client",
  "iframe-view",
  "tool-code",
  "resource-code",
  "widget-file",
];

const ALL_EDGES = [
  "e-step1",
  "e-step2",
  "e-step3",
  "e-step4",
  "e-postmessage",
];

export const MCP_APPS_STEP_HIGHLIGHTS: Record<McpAppsStep, StepHighlightMap> =
  {
    intro: {
      activeNodes: ALL_NODES,
      activeEdges: ALL_EDGES,
    },
    host_client: {
      activeNodes: ["host-group", "ai-client", "iframe-view"],
      activeEdges: [],
    },
    tool_definition: {
      activeNodes: ["ai-client", "tool-code"],
      activeEdges: ["e-step1"],
    },
    ui_resource: {
      activeNodes: ["tool-code", "resource-code"],
      activeEdges: ["e-step2"],
    },
    widget_component: {
      activeNodes: ["resource-code", "widget-file"],
      activeEdges: ["e-step3"],
    },
    iframe_view: {
      activeNodes: ["widget-file", "iframe-view"],
      activeEdges: ["e-step4", "e-postmessage"],
    },
    lifecycle: {
      activeNodes: ALL_NODES,
      activeEdges: ALL_EDGES,
    },
  };

const TOOL_SNIPPET = `server.tool("dashboard", schema, async (input) => ({
  structuredContent: input,
  _meta: {
    ui: {
      resourceUri: "ui://my-server/dashboard"
    }
  }
}));`;

const RESOURCE_SNIPPET = `server.resource(
  "dashboard",
  "ui://my-server/dashboard",
  {
    mimeType: "text/html;profile=mcp-app"
  },
  async () => ({ contents: [...] })
);`;

const NODES: ArchNodeDef[] = [
  {
    id: "host-group",
    label: "Host Application",
    type: "group",
    color: "#6366f1",
    position: { x: 0, y: 0 },
    width: 300,
    height: 280,
  },
  {
    id: "ai-client",
    label: "AI Client",
    subtitle: "Claude, ChatGPT, etc.",
    icon: Bot,
    type: "block",
    color: "#3b82f6",
    position: { x: 70, y: 45 },
    parentId: "host-group",
  },
  {
    id: "iframe-view",
    label: "iFrame View",
    subtitle: "Sandboxed HTML",
    icon: AppWindow,
    type: "block",
    color: "#8b5cf6",
    position: { x: 70, y: 170 },
    parentId: "host-group",
  },
  {
    id: "tool-code",
    label: "MCP Server: Tool",
    subtitle: "_meta.ui.resourceUri",
    icon: Wrench,
    type: "asset",
    assetType: "code",
    code: TOOL_SNIPPET,
    codeLang: "typescript",
    color: "#f59e0b",
    position: { x: 400, y: 20 },
    width: 280,
    height: 180,
  },
  {
    id: "resource-code",
    label: "MCP Server: Resource",
    subtitle: "ui:// + MCP App MIME type",
    icon: Database,
    type: "asset",
    assetType: "code",
    code: RESOURCE_SNIPPET,
    codeLang: "typescript",
    color: "#f59e0b",
    position: { x: 400, y: 260 },
    width: 280,
    height: 180,
  },
  {
    id: "widget-file",
    label: "Widget Component",
    subtitle: "dashboard.js",
    icon: FileCode,
    type: "block",
    color: "#10b981",
    position: { x: 180, y: 360 },
  },
];

const EDGES: ArchEdgeDef[] = [
  {
    id: "e-step1",
    source: "ai-client",
    target: "tool-code",
    label: "Step 1: Client calls tool",
  },
  {
    id: "e-step2",
    source: "tool-code",
    target: "resource-code",
    label: "Step 2: Tool links to resource",
  },
  {
    id: "e-step3",
    source: "resource-code",
    target: "widget-file",
    label: "Step 3: Resource serves widget",
    sourceHandle: "bottom",
    targetHandle: "top",
  },
  {
    id: "e-step4",
    source: "widget-file",
    target: "iframe-view",
    label: "Step 4: Widget renders in iframe",
  },
  {
    id: "e-postmessage",
    source: "iframe-view",
    target: "ai-client",
    label: "postMessage (JSON-RPC)",
    bidirectional: true,
  },
];

export function buildMcpAppsScenario(): ArchDiagramScenario {
  return { nodes: NODES, edges: EDGES };
}
