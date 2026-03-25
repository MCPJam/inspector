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
      "MCP Apps is an official extension to MCP that lets servers ship rich, interactive HTML user interfaces into the host — not just text tool results. One implementation can run in Claude, VS Code, ChatGPT, and other conforming hosts: build once, deploy everywhere over the same JSON-RPC patterns you already use.",
    category: "overview",
    analogy:
      "Standard MCP tools are like getting a receipt; MCP Apps is like the host opening a live panel where the user can explore, configure, or act — still driven by the same server, but with a real UI.",
    teachableMoments: [
      "Hosts still call tools and read resources; the difference is tools can declare a linked UI resource and return structured content that fills that UI.",
      "Communication between the embedded view and the host uses JSON-RPC 2.0 over postMessage, so the widget and host stay loosely coupled.",
      "Security is part of the spec: sandboxed iframes, CSP metadata on resources, and an auditable message channel — not bolt-on afterthoughts.",
    ],
    tips: [
      "If you know tools, resources, and MCP initialization, you already know most of the story; MCP Apps layers UI resources and tool metadata on top.",
    ],
  },

  host_client: {
    title: "Host and AI client",
    summary:
      "The host (desktop app, IDE, or web surface) loads your server, discovers tools and resources, and when a tool declares a UI, fetches the HTML template, injects it in a sandboxed iframe, and coordinates the MCP Apps handshake. The AI client is the same protocol bridge as in core MCP; it proxies tool calls and streams results to both the model and the view.",
    category: "architecture",
    teachableMoments: [
      "Hosts may prefetch UI templates when tools/list exposes _meta.ui so the iframe is warm before the user needs it.",
      "The visible 'iframe view' is a dedicated sandbox: it does not get direct DOM access to the host page.",
      "Theme integration often uses CSS variables (for example font and color tokens) so widgets feel native without sharing code.",
    ],
    tips: [
      "When debugging, trace both the MCP session and the postMessage log — the UI half of the flow is easy to miss if you only watch JSON-RPC on the transport.",
    ],
  },

  tool_definition: {
    title: "Tool ↔ UI linkage",
    summary:
      "Tools opt into MCP Apps by advertising which UI resource renders their output. The host reads _meta.ui.resourceUri on the tool definition (for example alongside tools/list) so it knows which ui:// resource to load when that tool runs — enabling caching, validation, and safe prefetch before any tool invocation.",
    category: "protocol",
    teachableMoments: [
      "Keeping the URI on the tool definition (not only in ad-hoc results) lets hosts treat UI pairing as stable metadata.",
      "Structured content in the tool result carries the data payload the widget expects; text content can still serve as a plain fallback.",
      "Predeclared resources improve performance and security: the host can allowlist URIs and never execute surprise HTML from unstructured text.",
    ],
    tips: [
      "Name tools and describe them clearly for the model; the UI URI is for the host — the model still reasons from descriptions and schemas.",
    ],
    examples: [
      '_meta: { ui: { resourceUri: "ui://my-server/dashboard" } }',
    ],
  },

  ui_resource: {
    title: "UI resources (ui://)",
    summary:
      "UI resources are normal MCP resources using the ui:// URI scheme and MIME type text/html;profile=mcp-app. resources/list tells the host what exists; resources/read returns HTML plus optional _meta.ui details such as CSP allowlists, permissions, and presentation hints — separating template structure from per-invocation data.",
    category: "protocol",
    teachableMoments: [
      "CSP metadata declares which remote origins may be used for scripts, images, fetch, or nested frames — tightening the sandbox beyond a bare iframe.",
      "Template HTML is static or parameterized at read time; dynamic values usually arrive later via structured tool results and UI notifications.",
      "The ui:// scheme makes UI endpoints identifiable across servers the same way file or custom schemes identify other resource families.",
    ],
    tips: [
      "Validate that resources/read returns the profile MIME type; hosts rely on it to treat the payload as an MCP App.",
    ],
    examples: [
      '"uri": "ui://weather-server/dashboard"',
      '"mimeType": "text/html;profile=mcp-app"',
    ],
  },

  widget_component: {
    title: "Widget code in the sandbox",
    summary:
      "The downloaded HTML and JavaScript run inside the isolated iframe. After load, the view sends an initialize-style MCP Apps handshake over postMessage, then listens for notifications such as tool-input and tool-result to render state. User actions can trigger proxied tools/call back through the host using the same JSON-RPC envelope.",
    category: "protocol",
    teachableMoments: [
      "window.parent.postMessage carries jsonrpc 2.0 objects; the host validates origin and correlation IDs before forwarding.",
      "Structured content from the server maps cleanly to widget state; keep schemas small and versioned when you evolve the UI.",
      "You do not need a specific UI framework — vanilla JS or any bundle that runs in a strict sandbox is fine.",
    ],
    tips: [
      "Handle failures gracefully: if the handshake or a notification errors, show a fallback message instead of a blank iframe.",
    ],
  },

  iframe_view: {
    title: "Iframe view and postMessage",
    summary:
      "Many hosts use a second, inner iframe or hardened wrapper so untrusted HTML never shares the host origin. Bidirectional arrows on the diagram are literal: the widget posts JSON-RPC to the host, and the host pushes notifications and results down — including theme tokens and proxied server responses.",
    category: "architecture",
    teachableMoments: [
      "Double-iframe or broker patterns reduce blast radius: even if widget HTML is malicious, outer policy constraints still apply.",
      "Bidirectional flows include initialize, notifications/tool-input, notifications/tool-result, and proxied tools/call as needed.",
      "Hosts may inject style variables before your script runs so the widget matches light/dark and typography automatically.",
    ],
    tips: [
      "Log postMessage traffic during development; it is the quickest way to see skew between what the server sent and what the widget received.",
    ],
  },

  lifecycle: {
    title: "Lifecycle and degradation",
    summary:
      "A typical flow spans four phases: capability negotiation (extension id such as io.modelcontextprotocol/ui during MCP initialize), discovery (tools/list and resources/list including UI entries), activation (tool invocation loads the widget and structured data), and teardown (disconnect or navigation tears down iframes and channels). When the host or server cannot support MCP Apps, structured text and standard tool results still work.",
    category: "security",
    teachableMoments: [
      "Capability negotiation ensures neither side assumes UI support the peer does not advertise.",
      "Graceful degradation means your tool should always return meaningful text or errors even if no iframe appears.",
      "Closing the session should cancel in-flight UI calls and drop postMessage listeners to avoid leaks.",
    ],
    tips: [
      "Treat CSP and permission metadata as mandatory inputs to your deployment review — they are how you document data egress for a widget.",
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
