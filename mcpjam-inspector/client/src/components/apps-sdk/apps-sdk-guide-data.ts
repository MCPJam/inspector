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
      "The OpenAI Apps SDK is not a separate protocol — it layers ChatGPT-specific capabilities on top of standard MCP Apps. Your backend is a standard MCP server, your UI runs in a sandboxed iframe, and communication uses JSON-RPC over postMessage. The difference is window.openai — a global object ChatGPT injects into the iframe with APIs for file uploads, checkout, modals, and widget state persistence. Strip away window.openai and what remains is a portable MCP App.",
    category: "overview",
    analogy:
      "If MCP Apps is a universal power outlet that works in every country, the Apps SDK is an adapter that adds USB-C ports when you plug into a ChatGPT wall socket. The standard prongs still work everywhere — the extra ports are a bonus.",
    teachableMoments: [
      "The standard MCP layer (tools, resources, ui:// scheme, JSON-RPC transport) is portable across Claude, Goose, VS Code, and any conforming host.",
      "The ChatGPT extension layer (window.openai.*, openai/outputTemplate, widget state, file uploads, checkout) only works inside ChatGPT.",
      "A well-built Apps SDK app is also a valid MCP App — the ChatGPT-specific parts are progressive enhancements, not requirements.",
    ],
    tips: [
      "OpenAI recommends: build around MCP Apps standards first, then enhance with window.openai only when necessary.",
    ],
  },

  host_model: {
    title: "ChatGPT host and AI model",
    summary:
      "The ChatGPT host runs your MCP server, discovers tools and resources, and when a tool declares a UI, renders the widget in a sandboxed iframe. The AI model calls tools via standard JSON-RPC — the same protocol bridge as any MCP host. What makes ChatGPT different is that it injects window.openai into the iframe and automatically adds client metadata (openai/locale, openai/subject, openai/session) to every tool call your server receives.",
    category: "architecture",
    teachableMoments: [
      "ChatGPT injects context signals — theme, displayMode, locale, safeArea — as window.openai properties. In standard MCP Apps these arrive via HostContext in the initialize response.",
      "Client metadata (openai/locale, openai/userLocation, openai/subject) is added automatically to _meta on every tool call — useful for localization and analytics.",
      "The same MCP server code works in Claude Desktop, VS Code, or ChatGPT — the host differences are transparent to your server.",
    ],
    tips: [
      "When debugging, trace both the MCP session and the postMessage log — the UI half of the flow is easy to miss if you only watch JSON-RPC on the transport.",
    ],
  },

  tool_definition: {
    title: "Dual-protocol tool definition",
    summary:
      "Tools opt into both MCP Apps and the Apps SDK by declaring two UI linkage keys: the standard _meta.ui.resourceUri (works everywhere) and openai/outputTemplate (ChatGPT-specific). Additional openai/* metadata enhances the ChatGPT experience: invocation messages (openai/toolInvocation/invoking and /invoked) show custom status text, fileParams declares which inputs accept files, and security hints (readOnlyHint, destructiveHint) help ChatGPT present appropriate UI. Non-ChatGPT hosts simply ignore the openai/* keys.",
    category: "protocol",
    teachableMoments: [
      "openai/outputTemplate and _meta.ui.resourceUri can coexist on the same tool — ChatGPT reads the former, other hosts read the latter.",
      "Invocation messages are purely cosmetic — they do not affect tool behavior, and non-ChatGPT hosts simply ignore them.",
      "Security hints like readOnlyHint and destructiveHint help ChatGPT decide whether to auto-approve or warn the user before running a tool.",
    ],
    tips: [
      "Prefer _meta.ui.resourceUri as the primary linkage; add openai/outputTemplate only for backward compatibility with older ChatGPT clients.",
    ],
    examples: [
      '"openai/toolInvocation/invoking": "Analyzing your dataset..."',
      '"openai/fileParams": ["file"]',
    ],
  },

  tool_result: {
    title: "Tool results: three fields, three audiences",
    summary:
      "When a tool returns a result, three fields control who sees what. content (text) goes to the chat transcript — it is what text-only hosts display. structuredContent carries typed data visible to both the model (for reasoning) and the widget (via window.openai.toolOutput in ChatGPT, or ui/notifications/tool-result in MCP Apps). _meta carries widget-only payload the model never sees — accessed via window.openai.toolResponseMetadata in ChatGPT, or via the notification params in other hosts.",
    category: "protocol",
    teachableMoments: [
      "content is the plain-text fallback: always include it so hosts without UI support still get useful output.",
      "structuredContent is the primary data channel — keep schemas small, versioned, and documented since both model and widget depend on them.",
      "_meta is for debug info, cache flags, or UI-only state that should never reach the model's context window.",
    ],
    tips: [
      "Put model-relevant data in structuredContent, widget-only data in _meta. Mixing them up wastes model context or exposes internal details.",
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
      "The widget has two communication paths. The MCP Apps bridge (postMessage with JSON-RPC) handles tools/call, ui/message, ui/open-link, and display mode — these work cross-host. window.openai provides convenience wrappers for the same operations plus ChatGPT-only features: file uploads (uploadFile, selectFiles), checkout (requestCheckout), modals (requestModal), and widget state persistence (widgetState, setWidgetState). Feature-detect at startup and branch accordingly.",
    category: "architecture",
    analogy:
      "The MCP bridge is a public road any car can drive on. window.openai is a private express lane only ChatGPT vehicles can enter — faster and with extra services, but not available everywhere.",
    teachableMoments: [
      "Four operations overlap: callTool vs tools/call, sendFollowUpMessage vs ui/message, openExternal vs ui/open-link, requestDisplayMode vs ui/request-display-mode. Use the bridge version for portability.",
      "Five features are ChatGPT-only with no bridge equivalent: uploadFile, selectFiles, requestCheckout, requestModal, widgetState/setWidgetState.",
      "Widget state persistence (setWidgetState / widgetState) saves and restores UI state across renders — unique to the Apps SDK. In MCP Apps you would need server-side storage.",
    ],
    tips: [
      "Write a thin abstraction that feature-detects window.openai and falls back to the bridge — this keeps your widget code clean and portable.",
    ],
    examples: [
      "if (window.openai?.callTool) { await window.openai.callTool(name, args) }",
      "else { await sendRequest('tools/call', { name, arguments: args }) }",
    ],
  },

  iframe_view: {
    title: "iFrame view and communication",
    summary:
      "The widget runs in a sandboxed iframe with no direct DOM access to the host page. Communication is bidirectional: the widget posts JSON-RPC to the host via postMessage, and the host pushes notifications (tool-input, tool-result, theme changes) back down. In ChatGPT, window.openai provides the same data as properties — toolInput, toolOutput, toolResponseMetadata, theme — plus exclusive capabilities like height reporting (notifyIntrinsicHeight) and display mode switching.",
    category: "architecture",
    teachableMoments: [
      "The initialize handshake works the same way: widget sends initialize over postMessage, host responds with capabilities, widget sends notifications/initialized.",
      "Bidirectional flows include initialize, notifications/tool-input, notifications/tool-result, and proxied tools/call — the same as MCP Apps.",
      "Hosts may inject CSS variables before your script runs so the widget matches light/dark and typography automatically. In ChatGPT, use window.openai.theme instead.",
    ],
    tips: [
      "Log postMessage traffic during development — it is the quickest way to see skew between what the server sent and what the widget received.",
    ],
  },

  dual_protocol: {
    title: "Dual-protocol support and deployment",
    summary:
      "A single tool can declare support for both MCP Apps and the Apps SDK simultaneously. MCPJam Inspector uses a 4-level detection hierarchy: both _meta.ui.resourceUri and openai/outputTemplate present means OPENAI_SDK_AND_MCP_APPS, only outputTemplate means OPENAI_SDK, only resourceUri means MCP_APPS, and inline ui:// resources mean MCP_UI. Build your widget on the MCP bridge for core functionality, layer window.openai enhancements with feature detection, and deploy to ChatGPT via HTTPS + the /mcp path convention.",
    category: "overview",
    teachableMoments: [
      "When both protocols are available, ChatGPT defaults to the Apps SDK path (window.openai). Other hosts use the MCP Apps path. One codebase, two behaviors.",
      "Deployment requires HTTPS (ngrok for dev), CORS headers, and the /mcp path. Or skip all that with MCPJam Inspector for local development.",
      "Common gotchas: window.openai undefined outside ChatGPT, _meta is widget-only (do not put model data there), sendFollowUpMessage creates assistant messages while ui/message creates user messages.",
    ],
    tips: [
      "Feature-detect window.openai at startup and set a flag. Use the flag throughout your widget code rather than checking window.openai on every call.",
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
