import { MCP_APPS_STEP_ORDER, type McpAppsStep } from "./mcp-apps-data";

export interface McpAppsStepGuide {
  title: string;
  summary: string;
  category: "overview" | "architecture" | "protocol" | "security";
  teachableMoments: string[];
  tips: string[];
  analogy?: string;
  examples?: string[];
}

export const MCP_APPS_GUIDE_METADATA: Record<McpAppsStep, McpAppsStepGuide> = {
  intro: {
    title: "What MCP Apps adds",
    summary:
      "MCP Apps lets a server open a real UI inside the host instead of only returning text.",
    category: "overview",
    analogy:
      "Normal MCP tools are like getting a receipt. MCP Apps is like opening a live panel you can click around in.",
    teachableMoments: [
      "A tool can point to a UI resource, and the host loads that UI when the tool runs.",
      "The UI and host still talk with MCP-style JSON-RPC messages.",
    ],
    tips: [
      "If you already know tools and resources, MCP Apps is the same idea plus a sandboxed UI.",
    ],
  },

  host_client: {
    title: "Host and AI client",
    summary:
      "The host finds the tool, loads the UI in a sandboxed iframe, and passes data between the model, server, and widget.",
    category: "architecture",
    teachableMoments: [
      "The iframe is isolated, so widget code does not directly control the host page.",
      "The host can also pass theme info so the UI feels native.",
    ],
    tips: [
      "When debugging, watch both MCP traffic and postMessage traffic.",
    ],
  },

  tool_definition: {
    title: "Tool ↔ UI linkage",
    summary:
      "A tool links to a UI by naming the UI resource the host should load.",
    category: "protocol",
    teachableMoments: [
      "The host reads the UI URI before the tool runs, so it knows what to open.",
      "Tool results can still include plain text as a fallback for hosts without UI support.",
    ],
    tips: [
      "The model uses the tool description. The host uses the UI URI.",
    ],
    examples: ['_meta: { ui: { resourceUri: "ui://my-server/dashboard" } }'],
  },

  ui_resource: {
    title: "UI resources (ui://)",
    summary:
      "UI resources are special MCP resources that return HTML for the widget.",
    category: "protocol",
    teachableMoments: [
      "They usually use the ui:// scheme and an HTML mime type profile for MCP Apps.",
      "Security metadata can tell the host which external origins the widget may use.",
    ],
    tips: [
      "Keep layout HTML in the resource and runtime data in the tool result.",
    ],
    examples: [
      '"uri": "ui://weather-server/dashboard"',
      '"mimeType": "text/html;profile=mcp-app"',
    ],
  },

  widget_component: {
    title: "Widget code in the sandbox",
    summary:
      "The widget runs inside the iframe, receives data from the host, and can ask the host to call tools.",
    category: "protocol",
    teachableMoments: [
      "The widget and host talk through postMessage using JSON-RPC-shaped messages.",
      "The widget can render tool input, tool results, and errors.",
    ],
    tips: [
      "Show a fallback state if the handshake or tool call fails.",
    ],
  },

  iframe_view: {
    title: "Iframe view and postMessage",
    summary:
      "Hosts often use a hardened iframe setup so widget code stays isolated from the main app.",
    category: "architecture",
    teachableMoments: [
      "Messages go both ways: widget to host, and host back to widget.",
      "Theme values can be injected so the widget matches light and dark mode.",
    ],
    tips: [
      "Logging postMessage traffic is often the fastest way to debug UI bugs.",
    ],
  },

  lifecycle: {
    title: "Lifecycle and degradation",
    summary:
      "MCP Apps adds UI support on top of normal MCP, and it should still work gracefully when UI support is missing.",
    category: "security",
    teachableMoments: [
      "The host and server first agree that MCP Apps is supported.",
      "Tools should still return useful text even if no iframe opens.",
    ],
    tips: [
      "Always design a text fallback for hosts that do not support the widget.",
    ],
  },
};

export function nextMcpAppsStepId(current: string | undefined): McpAppsStep {
  if (!current) return MCP_APPS_STEP_ORDER[0];
  const idx = MCP_APPS_STEP_ORDER.indexOf(current as McpAppsStep);
  if (idx < 0 || idx >= MCP_APPS_STEP_ORDER.length - 1) {
    return MCP_APPS_STEP_ORDER[0];
  }
  return MCP_APPS_STEP_ORDER[idx + 1];
}

export function isLastMcpAppsStep(current: string | undefined): boolean {
  if (!current) return false;
  const idx = MCP_APPS_STEP_ORDER.indexOf(current as McpAppsStep);
  return idx === MCP_APPS_STEP_ORDER.length - 1;
}
