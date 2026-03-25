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
      activeNodes: ["host-group", "ai-client"],
      activeEdges: [],
    },
    tool_definition: {
      activeNodes: ["tool-code"],
      activeEdges: ["e-step1"],
    },
    ui_resource: {
      activeNodes: ["resource-code"],
      activeEdges: ["e-step2"],
    },
    widget_component: {
      activeNodes: ["widget-file"],
      activeEdges: ["e-step3"],
    },
    iframe_view: {
      activeNodes: ["iframe-view"],
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
  { mimeType: "text/html;profile=mcp-app" },
  async () => ({
    contents: [{
      uri: "ui://my-server/dashboard",
      mimeType: "text/html;profile=mcp-app",
      text: "<!DOCTYPE html>..."
    }]
  })
);`;

const NODES: ArchNodeDef[] = [
  {
    id: "host-group",
    label: "Host Application",
    subtitle: "Claude Desktop, ChatGPT, VS Code, etc.",
    type: "group",
    color: "#6366f1",
    position: { x: 0, y: 0 },
    width: 320,
    height: 360,
  },
  {
    id: "ai-client",
    label: "AI Client",
    subtitle: "Calls MCP tools",
    icon: Bot,
    type: "block",
    color: "#3b82f6",
    position: { x: 80, y: 55 },
    parentId: "host-group",
  },
  {
    id: "iframe-view",
    label: "iFrame View",
    subtitle: "Sandboxed HTML",
    icon: AppWindow,
    type: "block",
    color: "#8b5cf6",
    position: { x: 80, y: 230 },
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
    position: { x: 500, y: 0 },
    width: 440,
    height: 220,
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
    color: "#10b981",
    position: { x: 500, y: 320 },
    width: 440,
    height: 260,
  },
  {
    id: "widget-file",
    label: "Widget Component",
    subtitle: "dashboard.js",
    icon: FileCode,
    type: "block",
    color: "#10b981",
    position: { x: 100, y: 500 },
    width: 200,
    height: 80,
  },
];

const EDGES: ArchEdgeDef[] = [
  {
    id: "e-step1",
    source: "ai-client",
    target: "tool-code",
    label: "Step 1: Client calls tool",
    sourceHandle: "right",
    targetHandle: "left",
    pathType: "bezier",
  },
  {
    id: "e-step2",
    source: "tool-code",
    target: "resource-code",
    label: "Step 2: Tool links to resource",
    sourceHandle: "bottom",
    targetHandle: "top",
    pathType: "bezier",
  },
  {
    id: "e-step3",
    source: "resource-code",
    target: "widget-file",
    label: "Step 3: Resource serves widget",
    sourceHandle: "left",
    targetHandle: "right",
    pathType: "bezier",
  },
  {
    id: "e-step4",
    source: "widget-file",
    target: "iframe-view",
    label: "Step 4: Widget renders in iframe",
    sourceHandle: "top",
    targetHandle: "bottom",
    pathType: "bezier",
  },
  {
    id: "e-postmessage",
    source: "iframe-view",
    target: "ai-client",
    label: "postMessage (JSON-RPC)",
    sourceHandle: "top",
    targetHandle: "bottom",
    pathType: "bezier",
    bidirectional: true,
  },
];

export function buildMcpAppsScenario(): ArchDiagramScenario {
  return { nodes: NODES, edges: EDGES };
}
