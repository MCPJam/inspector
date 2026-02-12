# MCPJam MCP Apps Rendering: Complete Guide

This document explains how MCPJam implements SEP-1865 (MCP Apps) to render interactive user interfaces from MCP servers.

## Overview

MCPJam implements SEP-1865 (MCP Apps) to render interactive user interfaces from MCP servers. The implementation uses a **double-iframe sandbox architecture** with JSON-RPC 2.0 over `postMessage` for secure, bidirectional communication.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     MCPJam Host (React App)                     │
│                                                                 │
│  ┌──────────────┐    ┌───────────────┐    ┌──────────────────┐ │
│  │  PartSwitch  │───▶│ MCPAppsRenderer│───▶│ SandboxedIframe  │ │
│  └──────────────┘    └───────────────┘    └──────────────────┘ │
│         │                    │                     │            │
│         │                    │                     ▼            │
│    Detects UI Type     AppBridge +          Cross-Origin       │
│    from tool _meta     PostMessageTransport  Sandbox Proxy     │
│                                                    │            │
└────────────────────────────────────────────────────│────────────┘
                                                     │
                    postMessage (JSON-RPC 2.0)       │
                                                     ▼
┌─────────────────────────────────────────────────────────────────┐
│              Sandbox Proxy (Different Origin)                   │
│              /api/mcp/sandbox-proxy (sandbox-proxy.html)        │
│                                                                 │
│  1. Creates inner iframe                                        │
│  2. Receives HTML via ui/notifications/sandbox-resource-ready   │
│  3. Builds CSP from metadata & injects into HTML                │
│  4. Relays messages between Host ↔ Guest UI                     │
└─────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Guest UI (MCP App Widget)                    │
│                    (inner srcdoc iframe)                        │
│                                                                 │
│  - Sends ui/initialize, receives McpUiInitializeResult          │
│  - Receives ui/notifications/tool-input                         │
│  - Receives ui/notifications/tool-result                        │
│  - Can call tools/call, resources/read, ui/message, etc.        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Step-by-Step Rendering Flow

### Step 1: Tool Detection (`part-switch.tsx:77-225`)

When a message part is rendered, `PartSwitch` detects the UI type:

```typescript
// part-switch.tsx:77-82
if (isToolPart(part) || isDynamicTool(part)) {
  const toolInfo = getToolInfo(toolPart);
  const partToolMeta = toolsMetadata[toolInfo.toolName];
  const uiType = detectUIType(partToolMeta, toolInfo.rawOutput);
  const uiResourceUri = getUIResourceUri(uiType, partToolMeta);
```

The detection logic in `mcp-apps-utils.ts:19-58`:

```typescript
export function detectUIType(toolMeta, toolResult): UIType | null {
  // 1. Check for both OpenAI SDK + MCP Apps
  if (
    toolMeta?.["openai/outputTemplate"] &&
    getToolUiResourceUri({ _meta: toolMeta })
  ) {
    return UIType.OPENAI_SDK_AND_MCP_APPS;
  }
  // 2. OpenAI SDK only
  if (toolMeta?.["openai/outputTemplate"]) return UIType.OPENAI_SDK;
  // 3. MCP Apps (SEP-1865): Check for ui.resourceUri in _meta
  if (getToolUiResourceUri({ _meta: toolMeta })) return UIType.MCP_APPS;
  // 4. Legacy MCP-UI: inline ui:// resources
  // ...
}
```

**Key check**: Per SEP-1865, tools declare UI resources via `_meta.ui.resourceUri`:

```json
{
  "name": "get_weather",
  "_meta": {
    "ui": {
      "resourceUri": "ui://weather-server/dashboard-template"
    }
  }
}
```

---

### Step 2: Render MCPAppsRenderer (`part-switch.tsx:165-222`)

When `uiType === UIType.MCP_APPS`, the `MCPAppsRenderer` component is rendered:

```tsx
<MCPAppsRenderer
  serverId={serverId}
  toolCallId={toolInfo.toolCallId}
  toolName={toolInfo.toolName}
  toolState={toolInfo.toolState}
  toolInput={toolInfo.input}
  toolOutput={toolInfo.output}
  resourceUri={uiResourceUri}
  toolMetadata={partToolMeta}
  toolsMetadata={toolsMetadata}
  onSendFollowUp={onSendFollowUp}
  onCallTool={(toolName, params) => callTool(serverId, toolName, params)}
  // ... display mode callbacks
/>
```

---

### Step 3: Fetch Widget HTML from Server (`mcp-apps-renderer.tsx:342-447`)

Once `toolState === "output-available"`, the renderer fetches the widget HTML:

```typescript
// mcp-apps-renderer.tsx:348-374
// 1. Store widget data
const storeResponse = await authFetch("/api/mcp/apps/widget/store", {
  method: "POST",
  body: JSON.stringify({
    serverId,
    resourceUri,
    toolInput,
    toolOutput,
    toolId: toolCallId,
    toolName,
    theme: themeMode,
    protocol: "mcp-apps",
    cspMode,
  }),
});

// 2. Fetch widget content with CSP metadata
const contentResponse = await fetch(
  `/api/mcp/apps/widget-content/${toolCallId}?csp_mode=${cspMode}`,
);
const { html, csp, permissions, permissive, prefersBorder } =
  await contentResponse.json();
```

---

### Step 4: Server-Side Resource Fetching (`apps.ts:116-224`)

The server reads the UI resource from the MCP server:

```typescript
// apps.ts:134-137
const resourceResult = await mcpClientManager.readResource(serverId, {
  uri: resourceUri,
});
```

It validates the SEP-1865 mimetype:

```typescript
// apps.ts:148-159
const contentMimeType = content.mimeType;
const mimeTypeValid = contentMimeType === "text/html;profile=mcp-app";
```

And extracts CSP/permissions metadata:

```typescript
// apps.ts:171-175
const uiMeta = content._meta?.ui;
const csp = uiMeta?.csp; // { connectDomains, resourceDomains, frameDomains, baseUriDomains }
const permissions = uiMeta?.permissions; // { camera, microphone, geolocation, clipboardWrite }
```

---

### Step 5: Create Double-Iframe Sandbox (`sandboxed-iframe.tsx`)

The `SandboxedIframe` component creates a cross-origin sandbox:

```typescript
// sandboxed-iframe.tsx:90-108
const [sandboxProxyUrl] = useState(() => {
  const currentHost = window.location.hostname;
  // SEP-1865: Host and Sandbox MUST have different origins
  let sandboxHost: string;
  if (currentHost === "localhost") {
    sandboxHost = "127.0.0.1"; // Swap to different origin
  } else if (currentHost === "127.0.0.1") {
    sandboxHost = "localhost";
  }
  return `${protocol}//${sandboxHost}${portSuffix}/api/mcp/sandbox-proxy`;
});
```

The outer iframe loads the sandbox proxy:

```tsx
// sandboxed-iframe.tsx:213-222
<iframe
  ref={outerRef}
  src={sandboxProxyUrl} // Different origin!
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups..."
  allow={outerAllowAttribute} // camera *, microphone *, etc.
/>
```

---

### Step 6: Sandbox Proxy Initialization (`sandbox-proxy.html`)

The sandbox proxy (served from different origin) handles the handshake:

```javascript
// sandbox-proxy.html:313-320
// 1. Notify parent that sandbox is ready
window.parent.postMessage(
  {
    jsonrpc: "2.0",
    method: "ui/notifications/sandbox-proxy-ready",
    params: {},
  },
  "*",
);
```

The host receives this and sends the HTML:

```typescript
// sandboxed-iframe.tsx:192-210
useEffect(() => {
  if (!proxyReady || !html) return;
  outerRef.current?.contentWindow?.postMessage(
    {
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-resource-ready",
      params: { html, sandbox, csp, permissions, permissive },
    },
    sandboxProxyOrigin,
  );
}, [proxyReady, html, csp, permissions]);
```

---

### Step 7: CSP Injection and HTML Loading (`sandbox-proxy.html:93-180`)

The sandbox proxy builds the CSP from metadata:

```javascript
// sandbox-proxy.html:93-180
function buildCSP(csp) {
  if (!csp) {
    // Restrictive defaults per SEP-1865
    return [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "connect-src 'none'",
      // ...
    ].join("; ");
  }

  const connectDomains = (csp.connectDomains || []).map(sanitizeDomain);
  const resourceDomains = (csp.resourceDomains || []).map(sanitizeDomain);
  // Build CSP string from declared domains
}
```

Then injects the CSP into the HTML and loads it:

```javascript
// sandbox-proxy.html:275-299
if (permissive) {
  const permissiveCsp = "default-src * 'unsafe-inline' 'unsafe-eval'...";
  inner.srcdoc = injectCSP(html, permissiveCsp);
} else {
  const cspValue = buildCSP(csp);
  inner.srcdoc = injectCSP(html, cspValue);
}
```

---

### Step 8: AppBridge Connection (`mcp-apps-renderer.tsx:849-930`)

The host creates an `AppBridge` to communicate with the guest UI:

```typescript
// mcp-apps-renderer.tsx:857-874
const bridge = new AppBridge(
  null,
  { name: "mcpjam-inspector", version: __APP_VERSION__ },
  {
    openLinks: {},
    serverTools: {},
    serverResources: {},
    logging: {},
    sandbox: {
      csp: widgetPermissive ? undefined : widgetCsp,
      permissions: widgetPermissions,
    },
  },
  { hostContext: hostContextRef.current ?? {} },
);

// Connect via PostMessageTransport
const transport = new PostMessageTransport(
  iframe.contentWindow,
  iframe.contentWindow,
);
bridge.connect(transport);
```

---

### Step 9: Widget Initialization (Guest UI → Host)

The guest UI (MCP App) sends `ui/initialize`:

```typescript
// Guest UI (inside iframe) using SDK
const transport = new MessageTransport(window.parent);
const client = new Client({ name: "my-widget", version: "1.0.0" });
await client.connect(transport);
```

The host responds with `McpUiInitializeResult`:

```typescript
// Handled by AppBridge - host sends back:
{
  protocolVersion: "2025-06-18",
  hostCapabilities: { openLinks: {}, serverTools: {}, ... },
  hostInfo: { name: "mcpjam-inspector", version: "..." },
  hostContext: {
    theme: "dark",
    displayMode: "inline",
    locale: "en-US",
    timeZone: "America/New_York",
    platform: "web",
    styles: { variables: { "--color-background-primary": "#171717", ... } },
    toolInfo: { id: "...", tool: { name: "get_weather", inputSchema: {...} } }
  }
}
```

The guest UI then sends `ui/notifications/initialized`:

```typescript
bridge.oninitialized = () => {
  setIsReady(true);
};
```

---

### Step 10: Send Tool Input & Result (`mcp-apps-renderer.tsx:938-977`)

Once initialized, the host sends tool data:

```typescript
// mcp-apps-renderer.tsx:938-946 - Tool Input
useEffect(() => {
  if (!isReady || toolState !== "output-available") return;
  const bridge = bridgeRef.current;
  if (!bridge || lastToolInputRef.current !== null) return;
  bridge.sendToolInput({ arguments: toolInput ?? {} });
}, [isReady, toolInput, toolState]);

// mcp-apps-renderer.tsx:948-957 - Tool Result
useEffect(() => {
  if (!isReady || !toolOutput) return;
  bridge.sendToolResult(toolOutput);
}, [isReady, toolOutput]);
```

These send SEP-1865 notifications:

- `ui/notifications/tool-input` - The tool call arguments
- `ui/notifications/tool-result` - The tool execution result

---

### Step 11: Interactive Phase - Bridge Handlers (`mcp-apps-renderer.tsx:635-847`)

The `AppBridge` handles requests from the guest UI:

```typescript
// tools/call - Execute tool on MCP server
bridge.oncalltool = async ({ name, arguments: args }) => {
  // Check visibility (SEP-1865)
  if (isVisibleToModelOnly(toolsMetadata[name])) {
    throw new Error(`Tool "${name}" is not callable by apps`);
  }
  return await onCallTool(name, args);
};

// resources/read - Read MCP resource
bridge.onreadresource = async ({ uri }) => {
  const response = await authFetch(`/api/mcp/resources/read`, {
    body: JSON.stringify({ serverId, uri }),
  });
  return response.json();
};

// ui/message - Send message to chat
bridge.onmessage = async ({ content }) => {
  onSendFollowUp(content[0]?.text);
};

// ui/open-link - Open external URL
bridge.onopenlink = async ({ url }) => {
  window.open(url, "_blank", "noopener,noreferrer");
};

// ui/request-display-mode - Change display (inline/pip/fullscreen)
bridge.onrequestdisplaymode = async ({ mode }) => {
  setDisplayMode(mode);
  return { mode: actualMode };
};

// ui/update-model-context - Update model context for future turns
bridge.onupdatemodelcontext = async ({ content, structuredContent }) => {
  onModelContextUpdate(toolCallId, { content, structuredContent });
  return {};
};
```

---

### Step 12: Host Context Updates (`mcp-apps-renderer.tsx:932-936`)

When theme, display mode, or other context changes:

```typescript
useEffect(() => {
  const bridge = bridgeRef.current;
  if (!bridge || !isReady) return;
  bridge.setHostContext(hostContext); // Sends ui/notifications/host-context-changed
}, [hostContext, isReady]);
```

---

## Key Files Summary

| File                          | Purpose                                                |
| ----------------------------- | ------------------------------------------------------ |
| `part-switch.tsx`             | Routes tool parts to correct renderer based on UI type |
| `mcp-apps-renderer.tsx`       | Main MCP Apps renderer component                       |
| `mcp-apps-renderer-helper.ts` | CSS variables for theming (SEP-1865 styles)            |
| `mcp-apps-utils.ts`           | UI type detection, visibility checks                   |
| `sandboxed-iframe.tsx`        | Double-iframe sandbox wrapper                          |
| `sandbox-proxy.html`          | Cross-origin proxy that loads guest UI                 |
| `apps.ts` (server)            | Store widget data, serve HTML with CSP metadata        |

---

## Security Model (SEP-1865 Compliance)

### 1. Cross-Origin Isolation

Host uses `localhost`, sandbox uses `127.0.0.1` (or vice versa):

```typescript
// sandboxed-iframe.tsx:96-99
if (currentHost === "localhost") {
  sandboxHost = "127.0.0.1";
} else if (currentHost === "127.0.0.1") {
  sandboxHost = "localhost";
}
```

### 2. CSP Enforcement

The sandbox proxy injects CSP `<meta>` tags based on widget declarations:

```javascript
// Only allow declared domains
const cspValue = buildCSP({
  connectDomains: ["https://api.example.com"],
  resourceDomains: ["https://cdn.example.com"],
});
```

### 3. Permission Policy

Sandbox permissions map to iframe `allow` attribute:

```html
<iframe allow="camera *; microphone *; geolocation *"></iframe>
```

### 4. CSP Violation Tracking

Violations are forwarded to host via `postMessage`:

```javascript
document.addEventListener('securitypolicyviolation', (e) => {
  window.parent.postMessage({ type: 'mcp-apps:csp-violation', ... }, '*');
});
```

### 5. Tool Visibility

Apps cannot call `visibility: ["model"]` tools (SEP-1865 compliance):

```typescript
if (isVisibleToModelOnly(toolsMetadata[name])) {
  throw new Error(`Tool "${name}" is not callable by apps`);
}
```

---

## Message Flow Diagram

```
Host                    Sandbox Proxy              Guest UI
  │                          │                         │
  │    sandbox-proxy-ready   │                         │
  │◀─────────────────────────│                         │
  │                          │                         │
  │  sandbox-resource-ready  │                         │
  │─────────────────────────▶│   [loads HTML/srcdoc]   │
  │                          │                         │
  │                          │      ui/initialize      │
  │◀─────────────────────────│◀────────────────────────│
  │                          │                         │
  │   McpUiInitializeResult  │                         │
  │─────────────────────────▶│────────────────────────▶│
  │                          │                         │
  │                          │   ui/notif/initialized  │
  │◀─────────────────────────│◀────────────────────────│
  │                          │                         │
  │  ui/notif/tool-input     │                         │
  │─────────────────────────▶│────────────────────────▶│
  │                          │                         │
  │  ui/notif/tool-result    │                         │
  │─────────────────────────▶│────────────────────────▶│
  │                          │                         │
  │         [Interactive Phase - bidirectional]        │
  │◀────────────────────────▶│◀───────────────────────▶│
```

---

## SEP-1865 Protocol Messages

### Host → Guest UI Notifications

| Message                                 | Description                                   |
| --------------------------------------- | --------------------------------------------- |
| `ui/notifications/tool-input`           | Tool call arguments                           |
| `ui/notifications/tool-input-partial`   | Streaming partial arguments (optional)        |
| `ui/notifications/tool-result`          | Tool execution result                         |
| `ui/notifications/tool-cancelled`       | Tool execution was cancelled                  |
| `ui/notifications/host-context-changed` | Theme, display mode, or other context changed |
| `ui/resource-teardown`                  | Host notifies before teardown                 |

### Guest UI → Host Requests

| Message                   | Description                                         |
| ------------------------- | --------------------------------------------------- |
| `ui/initialize`           | Initialize connection, receive capabilities         |
| `tools/call`              | Execute a tool on the MCP server                    |
| `resources/read`          | Read a resource from the MCP server                 |
| `ui/message`              | Send message to chat interface                      |
| `ui/open-link`            | Request to open external URL                        |
| `ui/request-display-mode` | Request display mode change (inline/pip/fullscreen) |
| `ui/update-model-context` | Update model context for future turns               |
| `notifications/message`   | Log messages to host                                |

### Guest UI → Host Notifications

| Message                         | Description                              |
| ------------------------------- | ---------------------------------------- |
| `ui/notifications/initialized`  | Guest UI is ready                        |
| `ui/notifications/size-changed` | Content height changed (for auto-resize) |

---

## Host Context (McpUiHostContext)

The host provides context to the guest UI during initialization and updates:

```typescript
interface McpUiHostContext {
  theme?: "light" | "dark";
  displayMode?: "inline" | "fullscreen" | "pip";
  availableDisplayModes?: string[];
  locale?: string; // BCP 47, e.g., "en-US"
  timeZone?: string; // IANA, e.g., "America/New_York"
  userAgent?: string;
  platform?: "web" | "desktop" | "mobile";
  deviceCapabilities?: { touch?: boolean; hover?: boolean };
  safeAreaInsets?: { top: number; right: number; bottom: number; left: number };
  styles?: {
    variables?: Record<string, string>; // CSS custom properties
    css?: { fonts?: string }; // @font-face rules
  };
  toolInfo?: {
    id?: string;
    tool: { name: string; inputSchema: object; description?: string };
  };
}
```

For this host implementation, `containerDimensions` is intentionally omitted and inline app width remains host-controlled (`w-full`). Width values from `ui/notifications/size-changed` are ignored; only height is applied.

---

## Theming (SEP-1865 Style Variables)

The host provides CSS custom properties via `hostContext.styles.variables`:

```typescript
// mcp-apps-renderer-helper.ts
export const getMcpAppsStyleVariables = (
  themeMode: ThemeMode,
): McpUiStyles => ({
  "--color-background-primary": isDark ? "#171717" : "#ffffff",
  "--color-background-secondary": isDark ? "#262626" : "#f5f5f5",
  "--color-text-primary": isDark ? "#fafafa" : "#171717",
  "--color-text-secondary": isDark ? "#a3a3a3" : "#737373",
  "--color-border-primary": isDark ? "#404040" : "#e5e5e5",
  "--font-sans": "system-ui, -apple-system, ...",
  "--font-mono": "ui-monospace, SFMono-Regular, ...",
  "--border-radius-sm": "4px",
  "--border-radius-md": "8px",
  "--border-radius-lg": "12px",
  // ... more variables
});
```

Guest UIs should use these variables with fallbacks:

```css
.container {
  background: var(--color-background-primary, #ffffff);
  color: var(--color-text-primary, #171717);
  font-family: var(--font-sans, system-ui, sans-serif);
}
```

---

## Related Documentation

- [SEP-1865 Specification](https://github.com/anthropics/anthropic-cookbook/blob/main/misc/sep-1865-mcp-apps.md)
- [@modelcontextprotocol/ext-apps SDK](https://www.npmjs.com/package/@modelcontextprotocol/ext-apps)
