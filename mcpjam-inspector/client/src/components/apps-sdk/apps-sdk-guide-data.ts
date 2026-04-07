import { APPS_SDK_STEP_ORDER, type AppsSdkStep } from "./apps-sdk-data";

export interface AppsSdkStepGuide {
  title: string;
  summary: string;
  category: "overview" | "architecture" | "protocol" | "security";
  teachableMoments: string[];
  tips: string[];
  analogy?: string;
  examples?: string[];
}

export const APPS_SDK_GUIDE_METADATA: Record<AppsSdkStep, AppsSdkStepGuide> = {
  intro: {
    title: "What the Apps SDK adds to MCP",
    summary:
      "The Apps SDK keeps standard MCP Apps, then adds extra ChatGPT-only features on top.",
    category: "overview",
    analogy:
      "Think of it as a bonus adapter: the normal MCP plug still works, and ChatGPT adds a few extra ports.",
    teachableMoments: [
      "Your server is still a normal MCP server underneath.",
      "ChatGPT adds extras like window.openai, file uploads, checkout, and saved widget state.",
    ],
    tips: [
      "Build around standard MCP first, then add ChatGPT extras when needed.",
    ],
  },

  host_model: {
    title: "ChatGPT host and AI model",
    summary:
      "ChatGPT uses the same MCP flow as other hosts, but it also injects extra context and helper APIs.",
    category: "architecture",
    teachableMoments: [
      "ChatGPT passes theme, locale, and other context to the widget.",
      "The same MCP server can often still work in other hosts.",
    ],
    tips: ["Debug both the MCP session and the iframe messages."],
  },

  tool_definition: {
    title: "Dual-protocol tool definition",
    summary:
      "A tool can declare standard MCP UI metadata and extra ChatGPT-only metadata at the same time.",
    category: "protocol",
    teachableMoments: [
      "Other hosts ignore the openai/* fields and keep using the standard MCP fields.",
      "Those extra fields help ChatGPT show better status text and safer UI.",
    ],
    tips: ["Keep the standard MCP linkage so the tool stays portable."],
    examples: [
      '"openai/toolInvocation/invoking": "Analyzing your dataset..."',
      '"openai/fileParams": ["file"]',
    ],
  },

  tool_result: {
    title: "Tool results: three fields, three audiences",
    summary:
      "Tool results split data by audience: transcript text, shared structured data, and widget-only metadata.",
    category: "protocol",
    teachableMoments: [
      "content is the plain-text fallback that users can read in chat.",
      "structuredContent is for data both the model and widget may need, while _meta is widget-only.",
    ],
    tips: [
      "Put model-relevant data in structuredContent and hide UI-only data in _meta.",
    ],
    examples: [
      'content: [{ type: "text", text: "72°F" }]  → model + transcript',
      "structuredContent: { temp: 72 }  → model + widget",
      "_meta: { cacheHit: true }  → widget only",
    ],
  },

  widget_component: {
    title: "Widget: bridge vs window.openai",
    summary:
      "Widgets can use the standard MCP bridge or ChatGPT's window.openai helpers.",
    category: "architecture",
    analogy:
      "The bridge is the public road. window.openai is the ChatGPT express lane.",
    teachableMoments: [
      "The MCP bridge works across hosts.",
      "window.openai adds ChatGPT-only features like uploads, checkout, modals, and saved widget state.",
    ],
    tips: [
      "Feature-detect window.openai and fall back to the standard bridge.",
    ],
    examples: [
      "if (window.openai?.callTool) { await window.openai.callTool(name, args) }",
      "else { await sendRequest('tools/call', { name, arguments: args }) }",
    ],
  },

  iframe_view: {
    title: "iFrame view and communication",
    summary:
      "The widget still runs in a sandboxed iframe and talks to the host through messages.",
    category: "architecture",
    teachableMoments: [
      "The setup handshake is still very similar to normal MCP Apps.",
      "ChatGPT also exposes some host data directly on window.openai.",
    ],
    tips: [
      "If the UI looks out of sync, inspect the iframe message flow first.",
    ],
  },

  dual_protocol: {
    title: "Dual-protocol support and deployment",
    summary:
      "One tool can support both standard MCP Apps and the Apps SDK at the same time.",
    category: "overview",
    teachableMoments: [
      "ChatGPT can use the Apps SDK path while other hosts keep using the standard MCP Apps path.",
      "That means one widget codebase can serve both worlds if you design it carefully.",
    ],
    tips: [
      "Build the core flow on standard MCP, then layer Apps SDK extras on top.",
    ],
  },
};

export function nextAppsSdkStepId(current: string | undefined): AppsSdkStep {
  if (!current) return APPS_SDK_STEP_ORDER[0];
  const idx = APPS_SDK_STEP_ORDER.indexOf(current as AppsSdkStep);
  if (idx < 0 || idx >= APPS_SDK_STEP_ORDER.length - 1) {
    return APPS_SDK_STEP_ORDER[0];
  }
  return APPS_SDK_STEP_ORDER[idx + 1];
}

export function isLastAppsSdkStep(current: string | undefined): boolean {
  if (!current) return false;
  const idx = APPS_SDK_STEP_ORDER.indexOf(current as AppsSdkStep);
  return idx === APPS_SDK_STEP_ORDER.length - 1;
}
