import { FIXED_TIME, PROJECT_ID } from "./app-data";
const session = {
  _id: "visual-chat",
  chatSessionId: "visual-chat-session",
  projectId: PROJECT_ID,
  customTitle: "San Francisco weather",
  firstMessagePreview: "What is the weather in San Francisco?",
  status: "active",
  directVisibility: "private",
  modelId: "claude-haiku-4-5",
  modelSource: "hosted",
  messageCount: 3,
  version: 1,
  startedAt: FIXED_TIME,
  lastActivityAt: FIXED_TIME,
  isPinned: true,
  manualUnread: false,
  isUnread: false,
  messagesBlobUrl: "http://127.0.0.1:6290/visual/transcript",
  resumeConfig: {
    executionTarget: { kind: "adhoc" },
    selectedServers: ["Weather"],
  },
};
const result = {
  content: [{ type: "text", text: "San Francisco: 18°C, sunny" }],
  structuredContent: {
    city: "San Francisco",
    temperature: 18,
    condition: "Sunny",
  },
};
// Synthetic server content rendered through the production MCP Apps sandbox.
const widgetHtml = `<!doctype html><html><head><meta name="color-scheme" content="light dark"><style>body{margin:0;padding:24px;font:16px system-ui;background:var(--color-background-primary,Canvas);color:var(--color-text-primary,CanvasText)}h2{margin:0 0 12px;font-size:18px}strong{font-size:40px}p{margin:12px 0 0}</style></head><body><h2>San Francisco</h2><strong>18°C</strong><p>Sunny · Light wind</p><p>Updated January 15, 2026 at 12:00 UTC</p><script>addEventListener('message',e=>{if(e.data?.id===1){parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:220}},'*')}});parent.postMessage({jsonrpc:'2.0',id:1,method:'ui/initialize',params:{protocolVersion:'2025-06-18',appInfo:{name:'Weather',version:'1.0.0'},appCapabilities:{}}},'*');</script></body></html>`;
const snapshots = [
  {
    _id: "weather-widget",
    sessionId: session._id,
    toolCallId: "weather-call",
    toolName: "get_weather",
    serverId: "Weather",
    uiType: "mcp-apps",
    resourceUri: "ui://weather/app.html",
    widgetCsp: null,
    widgetPermissions: null,
    widgetPermissive: false,
    prefersBorder: true,
  },
];
export const chatQueries = {
  "directChatHistory:listCurrentHistory": { personal: [session], project: [] },
  "directChatHistory:getCurrentSession": session,
  "directChatHistory:getCurrentSessionWidgetSnapshots": snapshots,
};
export const chatResponses = {
  "/api/web/apps/mcp-apps/widget-content": {
    html: widgetHtml,
    csp: {
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    },
    permissions: {},
    permissive: false,
    mimeTypeValid: true,
  },
  "/api/web/chat-history/detail": {
    ok: true,
    session,
    widgetSnapshots: snapshots,
    turnTraces: [],
  },
  "/api/web/chat-history/action": { ok: true },
  "/visual/transcript": [
    { role: "user", content: "What is the weather in San Francisco?" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "weather-call",
          toolName: "get_weather",
          args: { city: "San Francisco" },
          result,
        },
      ],
    },
    {
      role: "assistant",
      content:
        "It is sunny and 18°C in San Francisco. A light jacket should be enough for your walk.",
    },
  ],
};
