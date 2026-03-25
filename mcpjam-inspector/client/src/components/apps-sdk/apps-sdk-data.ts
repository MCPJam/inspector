import { AppWindow, Wrench } from "lucide-react";
import type {
  ArchNodeDef,
  ArchEdgeDef,
  ArchDiagramScenario,
  StepHighlightMap,
} from "@/components/architecture-diagram";

// ---------------------------------------------------------------------------
// Steps — each maps to a specific diagram node, following the data flow
// ---------------------------------------------------------------------------

export type AppsSdkStep =
  | "intro"
  | "host_model"
  | "tool_definition"
  | "tool_result"
  | "widget_component"
  | "iframe_view"
  | "dual_protocol";

export const APPS_SDK_STEP_ORDER: AppsSdkStep[] = [
  "intro",
  "host_model",
  "tool_definition",
  "tool_result",
  "widget_component",
  "iframe_view",
  "dual_protocol",
];

// ---------------------------------------------------------------------------
// Highlights — each step lights up its target node(s) and incoming edge(s)
// ---------------------------------------------------------------------------

const ALL_NODES = [
  "host-group",
  "ai-model",
  "iframe-view",
  "tool-code",
  "result-code",
  "widget-file",
];

const ALL_EDGES = ["e-step1", "e-step2", "e-step3", "e-step4", "e-postmessage"];

export const APPS_SDK_STEP_HIGHLIGHTS: Record<AppsSdkStep, StepHighlightMap> = {
  intro: {
    activeNodes: ALL_NODES,
    activeEdges: ALL_EDGES,
  },
  host_model: {
    activeNodes: ["host-group", "ai-model"],
    activeEdges: [],
  },
  tool_definition: {
    activeNodes: ["tool-code"],
    activeEdges: ["e-step1"],
  },
  tool_result: {
    activeNodes: ["result-code"],
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
  dual_protocol: {
    activeNodes: ALL_NODES,
    activeEdges: ALL_EDGES,
  },
};

// ---------------------------------------------------------------------------
// Code snippets
// ---------------------------------------------------------------------------

const TOOL_SNIPPET = `server.tool("dashboard", schema, async (input) => ({
  structuredContent: input,
  _meta: {
    ui: {
      resourceUri: "ui://my-server/dashboard"
    },
    "openai/outputTemplate": "ui://my-server/dashboard",
    "openai/toolInvocation/invoking": "Loading..."
  }
}));`;

const RESULT_SNIPPET = `return {
  // Model sees (chat transcript)
  content: [{ type: "text", text: "72°F Sunny" }],
  // Model + widget (window.openai.toolOutput)
  structuredContent: { temp: 72, conditions: "Sunny" },
  // Widget only (window.openai.toolResponseMetadata)
  _meta: {
    cacheHit: true,
    ui: { resourceUri: "ui://weather/dash" }
  }
};`;

// ---------------------------------------------------------------------------
// Nodes  (mirrors MCP Apps layout: host-group left, code assets right,
//         widget-file bottom — same positions, sizes, reused assets)
// ---------------------------------------------------------------------------

const NODES: ArchNodeDef[] = [
  {
    id: "host-group",
    label: "ChatGPT Host",
    subtitle: "Apps SDK runtime environment",
    type: "group",
    color: "#6366f1",
    position: { x: 0, y: 0 },
    width: 320,
    height: 380,
    logos: [{ src: "/openai_logo.png", alt: "OpenAI" }],
  },
  {
    id: "ai-model",
    label: "AI Model",
    subtitle: "Calls MCP tools",
    type: "block",
    color: "#3b82f6",
    position: { x: 80, y: 55 },
    parentId: "host-group",
    logos: [
      { src: "/claude_logo.png", alt: "Claude" },
      { src: "/openai_logo.png", alt: "ChatGPT" },
    ],
  },
  {
    id: "iframe-view",
    label: "iFrame View",
    subtitle: "Sandboxed HTML",
    imageSrc: "/doom.png",
    imageAlt: "DOOM running as an MCP App",
    type: "block",
    color: "#8b5cf6",
    position: { x: 40, y: 180 },
    parentId: "host-group",
    width: 240,
    height: 140,
  },
  {
    id: "tool-code",
    label: "MCP Server: Tool",
    subtitle: "_meta.ui + openai/*",
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
    id: "result-code",
    label: "Tool Result",
    subtitle: "content + structuredContent + _meta",
    icon: AppWindow,
    type: "asset",
    assetType: "code",
    code: RESULT_SNIPPET,
    codeLang: "typescript",
    color: "#f97316",
    position: { x: 500, y: 320 },
    width: 440,
    height: 260,
  },
  {
    id: "widget-file",
    label: "Widget Component",
    subtitle: "dashboard.js",
    imageSrc: "/react-icon.png",
    imageAlt: "React component",
    type: "block",
    color: "#10b981",
    position: { x: 100, y: 500 },
    width: 200,
    height: 80,
  },
];

// ---------------------------------------------------------------------------
// Edges  (same loop as MCP Apps: model → tool → result → widget → iframe → model)
// ---------------------------------------------------------------------------

const EDGES: ArchEdgeDef[] = [
  {
    id: "e-step1",
    source: "ai-model",
    target: "tool-code",
    label: "Step 1: Model calls tool",
    sourceHandle: "right",
    targetHandle: "left",
    pathType: "bezier",
  },
  {
    id: "e-step2",
    source: "tool-code",
    target: "result-code",
    label: "Step 2: Tool returns 3-field result",
    sourceHandle: "bottom",
    targetHandle: "top",
    pathType: "bezier",
  },
  {
    id: "e-step3",
    source: "result-code",
    target: "widget-file",
    label: "Step 3: structuredContent → widget",
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
    target: "ai-model",
    label: "postMessage + window.openai",
    sourceHandle: "top",
    targetHandle: "bottom",
    pathType: "bezier",
    bidirectional: true,
  },
];

export function buildAppsSdkScenario(): ArchDiagramScenario {
  return { nodes: NODES, edges: EDGES };
}
