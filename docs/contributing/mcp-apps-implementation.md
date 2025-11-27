# MCP Apps Implementation Design Doc

**Author:** MCPJam Team  
**Status:** Draft  
**Created:** 2025-11-26  
**Target:** MCPJam Inspector

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Background & References](#background--references)
3. [Architecture Overview](#architecture-overview)
4. [Detection & Routing](#detection--routing)
5. [SandboxedIframe Component](#sandboxediframe-component-dry-foundation)
6. [MCPAppsRenderer Component](#mcpappsrenderer-component)
7. [Sandbox Proxy Architecture](#sandbox-proxy-architecture)
8. [JSON-RPC Communication Protocol](#json-rpc-communication-protocol)
9. [Host Context & Lifecycle](#host-context--lifecycle)
10. [Capability Advertising](#capability-advertising)
11. [Implementation Checklist](#implementation-checklist)
12. [File Changes Summary](#file-changes-summary)
13. [Migration Path](#migration-path)

---

## Executive Summary

This document describes how to add **MCP Apps** support to MCPJam Inspector. MCP Apps is a new unified standard (SEP-1865) for delivering interactive UIs through MCP, designed to replace both the proprietary OpenAI Apps SDK and the community MCP-UI approaches.

### Goals

- Support MCP Apps (`ui/resourceUri` metadata, `text/html+mcp` MIME type)
- Maintain backward compatibility with OpenAI Apps SDK (`openai/outputTemplate`)
- Maintain backward compatibility with MCP-UI (inline `ui://` resources)
- Use a double-iframe sandbox proxy architecture for web security
- Implement JSON-RPC over postMessage communication
- Advertise `io.modelcontextprotocol/ui` capability

### Non-Goals

- Streaming tool input (`ui/notifications/tool-input-partial`)
- Widget state persistence (keep existing `setWidgetState` as extension)
- Modifying existing OpenAI or MCP-UI renderers

### Key Design Principles

| Principle | Implementation |
|-----------|----------------|
| **Reuse existing patterns** | Widget store pattern same as `openai.ts`, uses `mcpClientManager.readResource()` |
| **DRY sandbox component** | `SandboxedIframe` for potential future OpenAI convergence |
| **No cross-contamination** | MCP Apps uses `window.mcpApp`, OpenAI uses `window.openai` (different iframes) |
| **Same error handling** | Same patterns as `openai-app-renderer.tsx` |
| **Simplest MVP** | Focus on core functionality, defer polish to Phase 2 |
| **Migration-ready** | Can swap for `@mcp-ui/client` AppRenderer when ready |

---

## Background & References

### Must-Read References

| Resource | Description |
|----------|-------------|
| [SEP-1865: MCP Apps Specification](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1865) | **Primary spec** - Full protocol definition |
| [MCP-UI PR #147: React Renderer for MCP Apps](https://github.com/MCP-UI-Org/mcp-ui/pull/147) | Reference implementation (pending merge) |
| [Official Sandbox Proxy HTML](https://gist.githubusercontent.com/ochafik/a9603ba2d6757d6038ce066eded4c354/raw/b7f04f9b94fe8ef48fc4b955a013f4b3fb38c799/sandbox_proxy.html) | **Reference sandbox proxy** from ext-apps maintainer |
| [modelcontextprotocol/ext-apps SDK](https://github.com/modelcontextprotocol/ext-apps) | Official MCP Apps SDK |
| [MCPJam OpenAI SDK Architecture](./openai-sdk-architecture.mdx) | Current implementation (NOT modified) |
| [MCP-UI Documentation](https://mcpui.dev/) | MCP-UI community project |

### Comparison: Our MCPAppsRenderer vs PR #147 AppRenderer

| Aspect | Our MCPAppsRenderer | PR #147 AppRenderer |
|--------|---------------------|---------------------|
| **Input** | `resourceUri` + `serverId` | Requires `client: Client` (full MCP SDK client) |
| **Resource Fetch** | Via HTTP API internally | Uses `client.readResource()` directly |
| **Flexibility** | Works with MCPJam's HTTP proxy | Tightly coupled to MCP SDK Client |
| **Sandbox** | Uses `SandboxedIframe` component | Uses `sandboxProxyUrl` prop |
| **Protocol** | JSON-RPC via postMessage | Same (SEP-1865 compliant) |

> **Note:** PR #147 reviewer @infoxicator flagged that passing the full `Client` instance is problematic. Our approach avoids this by using `resourceUri` + `serverId` and fetching via HTTP API. When PR #147 adds support for passing HTML directly, we can evaluate swapping.

### Terminology

| Term | Definition |
|------|------------|
| **MCP Apps** | The new unified standard (SEP-1865) for MCP UI delivery |
| **Host** | MCPJam Inspector - renders the UI and handles communication |
| **Guest UI** | The iframe content provided by the MCP server |
| **Sandbox Proxy** | Intermediate iframe for security isolation (web hosts only) |
| **Tool-UI Linkage** | Metadata associating a tool with a UI resource |

### UI Type Detection Priority

```
1. MCP Apps     → _meta["ui/resourceUri"]         → MCPAppsRenderer
2. OpenAI SDK   → _meta["openai/outputTemplate"]  → OpenAIAppRenderer (existing)
3. MCP-UI       → inline ui:// resource in result → UIResourceRenderer (existing)
4. Fallback     → none of the above               → Text/JSON display
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        MCPJam Inspector                              │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  ChatTabV2 / Thread                                          │    │
│  │  ┌─────────────────────────────────────────────────────────┐ │    │
│  │  │  PartSwitch (detectUIType)                              │ │    │
│  │  │  ┌─────────────┐ ┌─────────────┐ ┌──────────────────┐   │ │    │
│  │  │  │MCPAppsRender│ │OpenAIAppRend│ │UIResourceRenderer│   │ │    │
│  │  │  │ (NEW)       │ │ (UNCHANGED) │ │ (UNCHANGED)      │   │ │    │
│  │  │  └──────┬──────┘ └─────────────┘ └──────────────────┘   │ │    │
│  │  │         │                                                │ │    │
│  │  │  ┌──────▼──────┐                                        │ │    │
│  │  │  │SandboxedIfrm│  ← DRY reusable component              │ │    │
│  │  │  │ (NEW)       │                                        │ │    │
│  │  │  └──────┬──────┘                                        │ │    │
│  │  └─────────┼───────────────────────────────────────────────┘ │    │
│  └────────────┼─────────────────────────────────────────────────┘    │
│               │                                                      │
│  ┌────────────▼────────────────────────────────────────────────┐    │
│  │  Sandbox Proxy Iframe (shared at /api/mcp/sandbox-proxy)    │    │
│  │  ┌────────────────────────────────────────────────────────┐ │    │
│  │  │  Guest UI Iframe (srcdoc)                              │ │    │
│  │  │  ┌──────────────────────────────────────────────────┐  │ │    │
│  │  │  │  window.mcpApp API                                │  │ │    │
│  │  │  │  - callTool(), sendMessage(), openLink()          │  │ │    │
│  │  │  └──────────────────────────────────────────────────┘  │ │    │
│  │  └────────────────────────────────────────────────────────┘ │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                              │
                    postMessage (JSON-RPC 2.0)
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         MCP Server                                   │
│  ┌─────────────────┐    ┌─────────────────────────────────────────┐ │
│  │ Tool Definition │    │ UI Resource (ui://...)                   │ │
│  │ _meta: {        │    │ mimeType: "text/html+mcp"               │ │
│  │   "ui/resource  │───▶│ contents: "<html>...</html>"            │ │
│  │   Uri": "ui://..│    │ _meta.ui.csp: { connectDomains: [...] } │ │
│  │ }               │    └─────────────────────────────────────────┘ │
│  └─────────────────┘                                                 │
└─────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility |
|-----------|----------------|
| `detectUIType()` | Routes to correct renderer based on tool metadata |
| `MCPAppsRenderer` | JSON-RPC protocol handler, uses SandboxedIframe |
| `SandboxedIframe` | **DRY** double-iframe setup, message forwarding |
| `sandbox-proxy.html` | **Shared** security isolation layer |
| `OpenAIAppRenderer` | **UNCHANGED** - existing OpenAI SDK support |
| `UIResourceRenderer` | **UNCHANGED** - existing MCP-UI support |

---

## Detection & Routing

### Detection Function

Create `client/src/lib/mcp-apps-utils.ts`:

```typescript
import { isUIResource } from "@mcp-ui/client";

export type UIType = 'mcp-apps' | 'openai-sdk' | 'mcp-ui' | null;

/**
 * Detects which UI renderer to use based on tool metadata and result content.
 * 
 * Priority:
 * 1. MCP Apps (SEP-1865): ui/resourceUri in tool metadata
 * 2. OpenAI Apps SDK: openai/outputTemplate in tool metadata  
 * 3. MCP-UI: inline ui:// resource in tool result
 */
export function detectUIType(
  toolMeta: Record<string, any> | undefined,
  toolResult: any
): UIType {
  // 1. MCP Apps: Check for ui/resourceUri metadata
  if (toolMeta?.["ui/resourceUri"]) {
    return 'mcp-apps';
  }
  
  // 2. OpenAI SDK: Check for openai/outputTemplate metadata
  if (toolMeta?.["openai/outputTemplate"]) {
    return 'openai-sdk';
  }
  
  // 3. MCP-UI: Check for inline ui:// resource in result
  const content = toolResult?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (isUIResource(item)) {
        return 'mcp-ui';
      }
      // Also check nested resource
      if (
        item?.type === 'resource' && 
        item?.resource?.uri?.startsWith('ui://')
      ) {
        return 'mcp-ui';
      }
    }
  }
  
  return null;
}

/**
 * Extract the UI resource URI from tool metadata based on UI type.
 */
export function getUIResourceUri(
  uiType: UIType,
  toolMeta: Record<string, any> | undefined
): string | null {
  switch (uiType) {
    case 'mcp-apps':
      return toolMeta?.["ui/resourceUri"] ?? null;
    case 'openai-sdk':
      return toolMeta?.["openai/outputTemplate"] ?? null;
    default:
      return null;
  }
}
```

### Update PartSwitch in thread.tsx

```typescript
// In PartSwitch function
import { detectUIType, getUIResourceUri } from "@/lib/mcp-apps-utils";
import { MCPAppsRenderer } from "./mcp-apps-renderer";

// Inside the function:
if (isToolPart(part) || isDynamicTool(part)) {
  const toolName = isDynamicTool(part)
    ? (part as DynamicToolUIPart).toolName
    : getToolNameFromType((part as any).type);
  
  const toolMeta = toolsMetadata[toolName];
  const toolOutput = isDynamicTool(part)
    ? (part as DynamicToolUIPart).output
    : (part as any).output?.value;
  
  const uiType = detectUIType(toolMeta, toolOutput);
  const resourceUri = getUIResourceUri(uiType, toolMeta);
  
  // MCP Apps (SEP-1865)
  if (uiType === 'mcp-apps') {
    const serverId = getToolServerId(toolName, toolServerMap);
    return (
      <>
        <ToolPart part={part as ToolUIPart<UITools> | DynamicToolUIPart} />
        <MCPAppsRenderer
          serverId={serverId!}
          toolCallId={(part as any).toolCallId}
          toolName={toolName}
          toolState={(part as any).state}
          toolInput={(part as any).input}
          toolOutput={toolOutput}
          resourceUri={resourceUri!}
          toolMetadata={toolMeta}
          onSendFollowUp={onSendFollowUp}
          onCallTool={(name, params) => callTool(serverId!, name, params)}
          onWidgetStateChange={onWidgetStateChange}
          pipWidgetId={pipWidgetId}
          onRequestPip={onRequestPip}
          onExitPip={onExitPip}
        />
      </>
    );
  }
  
  // OpenAI SDK (existing)
  if (uiType === 'openai-sdk') {
    // ... existing OpenAIAppRenderer code
  }
  
  // MCP-UI (existing)  
  if (uiType === 'mcp-ui') {
    // ... existing UIResourceRenderer code
  }
}
```

---

## SandboxedIframe Component (DRY Foundation)

Create `client/src/components/ui/sandboxed-iframe.tsx`:

This is a **reusable component** for rendering HTML in a secure double-iframe sandbox. Currently only used by `MCPAppsRenderer`, but designed to be reusable for future consolidation (e.g., migrating `OpenAIAppRenderer` later).

```typescript
import { useRef, useState, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";

export interface SandboxedIframeHandle {
  postMessage: (data: any) => void;
}

interface SandboxedIframeProps {
  /** HTML content to render in the sandbox */
  html: string | null;
  /** Sandbox attribute for the inner iframe */
  sandbox?: string;
  /** Callback when sandbox proxy is ready */
  onProxyReady?: () => void;
  /** Callback for messages from guest UI (excluding sandbox-internal messages) */
  onMessage: (event: MessageEvent) => void;
  /** CSS class for the outer iframe */
  className?: string;
  /** Inline styles for the outer iframe */
  style?: React.CSSProperties;
  /** Title for accessibility */
  title?: string;
}

/**
 * SandboxedIframe provides a secure double-iframe architecture:
 * 
 * Host Page → Sandbox Proxy (different origin) → Guest UI
 * 
 * The sandbox proxy:
 * 1. Runs in a different origin for security isolation
 * 2. Loads guest HTML via srcdoc when ready
 * 3. Forwards messages between host and guest (except sandbox-internal)
 * 
 * Reference: https://gist.github.com/ochafik/a9603ba2d6757d6038ce066eded4c354
 */
export const SandboxedIframe = forwardRef<SandboxedIframeHandle, SandboxedIframeProps>(
  function SandboxedIframe(
    {
      html,
      sandbox = "allow-scripts allow-same-origin allow-forms allow-popups",
      onProxyReady,
      onMessage,
      className,
      style,
      title = "Sandboxed Content",
    },
    ref
  ) {
    const outerRef = useRef<HTMLIFrameElement>(null);
    const [proxyReady, setProxyReady] = useState(false);

    // Expose postMessage to parent
    useImperativeHandle(ref, () => ({
      postMessage: (data: any) => {
        outerRef.current?.contentWindow?.postMessage(data, "*");
      },
    }), []);

    // Handle messages from sandbox proxy
    useEffect(() => {
      const handler = (event: MessageEvent) => {
        if (event.source !== outerRef.current?.contentWindow) return;
        
        const { jsonrpc, method } = event.data || {};
        if (jsonrpc !== "2.0") return;

        // Sandbox ready notification (per SEP-1865)
        if (method === "ui/notifications/sandbox-ready") {
          setProxyReady(true);
          onProxyReady?.();
          return;
        }

        // Ignore other sandbox-internal messages
        if (method?.startsWith("ui/notifications/sandbox-")) {
          return;
        }

        // Forward all other messages to parent handler
        onMessage(event);
      };

      window.addEventListener("message", handler);
      return () => window.removeEventListener("message", handler);
    }, [onMessage, onProxyReady]);

    // Send HTML to sandbox when ready
    useEffect(() => {
      if (!proxyReady || !html) return;

      outerRef.current?.contentWindow?.postMessage({
        jsonrpc: "2.0",
        method: "ui/notifications/sandbox-resource-ready",
        params: { html, sandbox },
      }, "*");
    }, [proxyReady, html, sandbox]);

    return (
      <iframe
        ref={outerRef}
        src="/api/mcp/sandbox-proxy"
        sandbox="allow-scripts allow-same-origin"
        title={title}
        className={className}
        style={style}
      />
    );
  }
);
```

### Key Design Decisions

1. **DRY by design** - Reusable for any double-iframe sandbox use case
2. **Ref-based API** - Parent can call `postMessage()` via ref
3. **Protocol-agnostic** - Handles sandbox setup, parent handles message protocol
4. **Future-proof** - Can migrate `OpenAIAppRenderer` to use this later

---

## MCPAppsRenderer Component

Create `client/src/components/chat-v2/mcp-apps-renderer.tsx`:

```typescript
import { useRef, useState, useEffect, useCallback } from "react";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { X } from "lucide-react";
import { SandboxedIframe, SandboxedIframeHandle } from "@/components/ui/sandboxed-iframe";

type DisplayMode = "inline" | "pip" | "fullscreen";
type ToolState = "input-streaming" | "input-available" | "output-available" | "output-error";

interface MCPAppsRendererProps {
  serverId: string;
  toolCallId: string;
  toolName: string;
  toolState?: ToolState;
  toolInput?: Record<string, any>;
  toolOutput?: unknown;
  resourceUri: string;
  toolMetadata?: Record<string, any>;
  onSendFollowUp?: (text: string) => void;
  onCallTool?: (toolName: string, params: Record<string, any>) => Promise<any>;
  onWidgetStateChange?: (toolCallId: string, state: any) => void;
  pipWidgetId?: string | null;
  onRequestPip?: (toolCallId: string) => void;
  onExitPip?: (toolCallId: string) => void;
}

export function MCPAppsRenderer({
  serverId,
  toolCallId,
  toolName,
  toolState,
  toolInput,
  toolOutput,
  resourceUri,
  toolMetadata,
  onSendFollowUp,
  onCallTool,
  onWidgetStateChange,
  pipWidgetId,
  onRequestPip,
  onExitPip,
}: MCPAppsRendererProps) {
  const sandboxRef = useRef<SandboxedIframeHandle>(null);
  const themeMode = usePreferencesStore((s) => s.themeMode);
  
  const [displayMode, setDisplayMode] = useState<DisplayMode>("inline");
  const [contentHeight, setContentHeight] = useState<number>(400);
  const [maxHeight, setMaxHeight] = useState<number>(600);
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [widgetHtml, setWidgetHtml] = useState<string | null>(null);
  
  const pendingRequests = useRef<Map<number | string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>>(new Map());
  const nextRequestId = useRef(1);

  // Fetch widget HTML when tool output is available
  useEffect(() => {
    if (toolState !== "output-available") return;
    if (widgetHtml) return;

    const fetchWidgetHtml = async () => {
      try {
        // Store widget data first
        const storeResponse = await fetch("/api/mcp/apps/widget/store", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serverId,
            resourceUri,
            toolInput,
            toolOutput,
            toolId: toolCallId,
            toolName,
            theme: themeMode,
            protocol: 'mcp-apps',
          }),
        });

        if (!storeResponse.ok) {
          throw new Error(`Failed to store widget: ${storeResponse.statusText}`);
        }

        // Fetch the processed HTML with injected script
        const htmlResponse = await fetch(`/api/mcp/apps/widget-content/${toolCallId}`);
        if (!htmlResponse.ok) {
          throw new Error(`Failed to fetch widget HTML: ${htmlResponse.statusText}`);
        }
        
        const html = await htmlResponse.text();
        setWidgetHtml(html);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to prepare widget");
      }
    };

    fetchWidgetHtml();
  }, [toolState, toolCallId, widgetHtml, serverId, resourceUri, toolInput, toolOutput, toolName, themeMode]);

  // JSON-RPC helpers - use sandboxRef to post messages
  const postMessage = useCallback((data: any) => {
    sandboxRef.current?.postMessage(data);
  }, []);

  const sendNotification = useCallback((method: string, params: any) => {
    postMessage({ jsonrpc: "2.0", method, params });
  }, [postMessage]);

  const sendResponse = useCallback((id: number | string, result?: any, error?: any) => {
    postMessage({
      jsonrpc: "2.0",
      id,
      ...(error ? { error } : { result: result ?? {} }),
    });
  }, [postMessage]);

  // Handle messages from guest UI (via SandboxedIframe)
  const handleMessage = useCallback(async (event: MessageEvent) => {
    const { jsonrpc, id, method, params, result, error } = event.data;
    
    // Not a JSON-RPC message (shouldn't happen, SandboxedIframe filters)
    if (jsonrpc !== "2.0") return;

    // Handle responses to our requests
    if (id !== undefined && !method) {
      const pending = pendingRequests.current.get(id);
      if (pending) {
        pendingRequests.current.delete(id);
        if (error) {
          pending.reject(new Error(error.message || "Unknown error"));
        } else {
          pending.resolve(result);
        }
      }
      return;
    }

    // Handle requests from guest UI
    if (method && id !== undefined) {
      switch (method) {
        case "ui/initialize": {
          // Respond with host context
          sendResponse(id, {
            protocolVersion: "2025-06-18",
            hostCapabilities: {},
            hostInfo: { name: "mcpjam-inspector", version: "1.0.0" },
            hostContext: {
              theme: themeMode,
              displayMode,
              viewport: { width: 400, height: contentHeight, maxHeight },
              locale: navigator.language,
              platform: "web",
            },
          });
          setIsReady(true);
          break;
        }

        case "tools/call": {
          if (!onCallTool) {
            sendResponse(id, undefined, { code: -32601, message: "Tool calls not supported" });
            break;
          }
          try {
            const result = await onCallTool(params.name, params.arguments || {});
            sendResponse(id, result);
          } catch (err) {
            sendResponse(id, undefined, {
              code: -32000,
              message: err instanceof Error ? err.message : "Tool call failed",
            });
          }
          break;
        }

        case "resources/read": {
          try {
            const response = await fetch(`/api/mcp/resources/read`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ serverId, uri: params.uri }),
            });
            const result = await response.json();
            sendResponse(id, result);
          } catch (err) {
            sendResponse(id, undefined, {
              code: -32000,
              message: err instanceof Error ? err.message : "Resource read failed",
            });
          }
          break;
        }

        case "ui/open-link": {
          if (params.url) {
            window.open(params.url, "_blank", "noopener,noreferrer");
          }
          sendResponse(id, {});
          break;
        }

        case "ui/message": {
          if (onSendFollowUp && params.content?.text) {
            onSendFollowUp(params.content.text);
          }
          sendResponse(id, {});
          break;
        }

        default:
          sendResponse(id, undefined, { code: -32601, message: `Method not found: ${method}` });
      }
      return;
    }

    // Handle notifications from guest UI
    if (method && id === undefined) {
      switch (method) {
        case "ui/notifications/initialized":
          // Guest UI finished initialization, send tool data
          if (toolInput) {
            sendNotification("ui/notifications/tool-input", { arguments: toolInput });
          }
          if (toolOutput && toolState === "output-available") {
            sendNotification("ui/notifications/tool-result", toolOutput);
          }
          break;

        case "ui/size-change":
          if (typeof params.height === "number") {
            setContentHeight(Math.min(params.height, maxHeight));
          }
          break;

        case "notifications/message":
          console.log("[MCP Apps] Guest log:", params);
          break;
      }
    }
  }, [
    themeMode, displayMode, contentHeight, maxHeight,
    onCallTool, onSendFollowUp, serverId, toolInput, toolOutput, toolState,
    sendResponse, sendNotification,
  ]);

  // Send theme updates when theme changes
  useEffect(() => {
    if (!isReady) return;
    sendNotification("ui/host-context-change", { theme: themeMode });
  }, [themeMode, isReady, sendNotification]);

  // Loading states
  if (toolState !== "output-available") {
    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
        Waiting for tool to finish executing...
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="border border-destructive/40 bg-destructive/10 text-destructive text-xs rounded-md px-3 py-2">
        Failed to load MCP App: {loadError}
      </div>
    );
  }

  if (!widgetHtml) {
    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
        Preparing MCP App widget...
      </div>
    );
  }

  const isPip = displayMode === "pip" && pipWidgetId === toolCallId;
  const isFullscreen = displayMode === "fullscreen";
  const appliedHeight = Math.min(Math.max(contentHeight, 320), maxHeight);

  let containerClassName = "mt-3 space-y-2 relative group";
  if (isFullscreen) {
    containerClassName = "fixed inset-0 z-50 w-full h-full bg-background flex flex-col";
  } else if (isPip) {
    containerClassName = [
      "fixed top-4 inset-x-0 z-40 w-full max-w-4xl mx-auto space-y-2",
      "bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80",
      "shadow-xl border border-border/60 rounded-xl p-3",
    ].join(" ");
  }

  return (
    <div className={containerClassName}>
      {(isPip || isFullscreen) && (
        <button
          onClick={() => {
            setDisplayMode("inline");
            onExitPip?.(toolCallId);
          }}
          className="absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md bg-background/80 hover:bg-background border border-border/50 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      )}

      {/* Uses SandboxedIframe for DRY double-iframe architecture */}
      <SandboxedIframe
        ref={sandboxRef}
        html={widgetHtml}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        onMessage={handleMessage}
        title={`MCP App: ${toolName}`}
        className="w-full border border-border/40 rounded-md bg-background"
        style={{
          minHeight: "320px",
          height: isFullscreen ? "100%" : `${appliedHeight}px`,
        }}
      />

      <div className="text-[11px] text-muted-foreground/70">
        MCP App: <code>{resourceUri}</code>
      </div>
    </div>
  );
}
```

---

## Sandbox Proxy Architecture

The sandbox proxy provides security isolation by:
1. Running in a different origin than the host
2. Loading guest UI HTML via `srcdoc` 
3. Forwarding messages between host and guest

### Sandbox Proxy HTML

Create `server/routes/mcp/sandbox-proxy.html`:

> **Reference:** Based on [official sandbox_proxy.html from ext-apps maintainer](https://gist.githubusercontent.com/ochafik/a9603ba2d6757d6038ce066eded4c354/raw/b7f04f9b94fe8ef48fc4b955a013f4b3fb38c799/sandbox_proxy.html)

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <!-- Permissive CSP so nested content is not constrained by host CSP -->
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src * data: blob: 'unsafe-inline'; media-src * blob: data:; font-src * blob: data:; script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' 'unsafe-eval' blob: data: https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://unpkg.com http://localhost:* https://localhost:*; style-src * blob: data: 'unsafe-inline'; connect-src *; frame-src * blob: data: http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:*; base-uri 'self';" />
    <title>MCP-UI Proxy</title>
    <style>
      html,
      body {
        margin: 0;
        height: 100vh;
        width: 100vw;
      }
      body {
        display: flex;
        flex-direction: column;
      }
      * {
        box-sizing: border-box;
      }
      iframe {
        background-color: transparent;
        border: 0px none transparent;
        padding: 0px;
        overflow: hidden;
        flex-grow: 1;
      }
    </style>
  </head>
  <body>
    <script>
      // Double-iframe raw HTML mode (HTML sent via postMessage)
      const inner = document.createElement('iframe');
      inner.style = 'width:100%; height:100%; border:none;';
      // sandbox will be set from postMessage payload; default minimal before html arrives
      inner.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
      document.body.appendChild(inner);

      // Wait for HTML content from parent
      window.addEventListener('message', async (event) => {
        if (event.source === window.parent) {
          if (event.data && event.data.method === 'ui/notifications/sandbox-resource-ready') {
            const {html, sandbox} = event.data.params;
            if (typeof sandbox === 'string') {
              inner.setAttribute('sandbox', sandbox);
            }
            if (typeof html === 'string') {
              inner.srcdoc = html;
            }
          } else {
            if (inner && inner.contentWindow) {
              inner.contentWindow.postMessage(event.data, '*');
            }
          }
        } else if (event.source === inner.contentWindow) {
          // Relay messages from inner to parent
          window.parent.postMessage(event.data, '*');
        }
      });

      // Notify parent that sandbox is ready (per SEP-1865)
      window.parent.postMessage({
        jsonrpc: "2.0",
        method: 'ui/notifications/sandbox-ready',
        params: {}
      }, '*');
    </script>
  </body>
</html>
```

**Key features of official sandbox proxy:**
- Creates inner iframe immediately (before HTML arrives)
- Uses `ui/notifications/sandbox-proxy-ready` notification
- Includes CDN allowlist in CSP (tailwindcss, jsdelivr, unpkg)
- Supports both localhost and 127.0.0.1 in frame-src

### Server Route

Add to `server/routes/mcp/apps.ts`:

> **Note:** This follows the same widget store pattern as `openai.ts` and reuses the existing `/api/mcp/resources/read` endpoint.

```typescript
import { Hono } from "hono";
import "../../types/hono";

const apps = new Hono();

// Widget data store - SAME PATTERN as openai.ts
interface WidgetData {
  serverId: string;
  resourceUri: string;
  toolInput: Record<string, any>;
  toolOutput: any;
  toolId: string;
  toolName: string;
  theme?: "light" | "dark";
  protocol: "mcp-apps";
  timestamp: number;
}

const widgetDataStore = new Map<string, WidgetData>();

// Cleanup expired data every 5 minutes - SAME as openai.ts
setInterval(() => {
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  for (const [toolId, data] of widgetDataStore.entries()) {
    if (now - data.timestamp > ONE_HOUR) {
      widgetDataStore.delete(toolId);
    }
  }
}, 5 * 60 * 1000).unref();

// Store widget data - SAME pattern as openai.ts
apps.post("/widget/store", async (c) => {
  const body = await c.req.json();
  const { serverId, resourceUri, toolInput, toolOutput, toolId, toolName, theme, protocol } = body;

  widgetDataStore.set(toolId, {
    serverId,
    resourceUri,
    toolInput,
    toolOutput,
    toolId,
    toolName,
    theme,
    protocol,
    timestamp: Date.now(),
  });

  return c.json({ success: true });
});

// Note: Sandbox proxy is served at /api/mcp/sandbox-proxy (shared route)
// See server/routes/mcp/index.ts for mounting

// Serve widget content with injected MCP Apps script
apps.get("/widget-content/:toolId", async (c) => {
  const toolId = c.req.param("toolId");
  const widgetData = widgetDataStore.get(toolId);

  if (!widgetData) {
    return c.html("Error: Widget data not found or expired", 404);
  }

  const { serverId, resourceUri, toolInput, toolOutput, theme, toolName } = widgetData;
  const mcpClientManager = c.mcpClientManager;

  try {
    // REUSE existing mcpClientManager.readResource (same as resources.ts)
    const resourceResult = await mcpClientManager.readResource(serverId, { uri: resourceUri });

    // Extract HTML from resource contents
    const contents = resourceResult?.contents || [];
    const content = contents[0];

    if (!content) {
      return c.html("Error: No content in resource", 404);
    }

    let html: string;
    if (content.text) {
      html = content.text;
    } else if (content.blob) {
      html = Buffer.from(content.blob, "base64").toString("utf-8");
    } else {
      return c.html("Error: No HTML content in resource", 404);
    }

    // Inject MCP Apps client script - SAME pattern as openai.ts buildBridgeScript
    const mcpAppsScript = buildMCPAppsScript({
      toolId,
      toolName,
      toolInput,
      toolOutput,
      theme,
    });

    // Inject script into <head> - SAME as openai.ts
    if (html.includes("<head>")) {
      html = html.replace("<head>", `<head>${mcpAppsScript}`);
    } else if (html.includes("<html>")) {
      html = html.replace("<html>", `<html><head>${mcpAppsScript}</head>`);
    } else {
      html = mcpAppsScript + html;
    }

    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    return c.body(html);
  } catch (err) {
    console.error("[MCP Apps] Error fetching resource:", err);
    return c.html(`Error: ${err instanceof Error ? err.message : "Unknown error"}`, 500);
  }
});

function buildMCPAppsScript(opts: {
  toolId: string;
  toolName: string;
  toolInput: any;
  toolOutput: any;
  theme?: string;
}): string {
  const { toolId, toolName, toolInput, toolOutput, theme } = opts;
  
  return `
<script>
(function() {
  'use strict';
  
  const pending = new Map();
  let nextId = 1;
  let hostContext = {};

  function sendRequest(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('Request timeout: ' + method));
        }
      }, 30000);
    });
  }

  function sendNotification(method, params) {
    window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
  }

  window.addEventListener('message', (event) => {
    const { jsonrpc, id, method, params, result, error } = event.data;
    if (jsonrpc !== '2.0') return;

    // Handle responses to our requests
    if (id !== undefined && pending.has(id)) {
      const { resolve, reject } = pending.get(id);
      pending.delete(id);
      if (error) {
        reject(new Error(error.message || 'Unknown error'));
      } else {
        resolve(result);
      }
      return;
    }

    // Handle notifications from host
    if (method === 'ui/notifications/tool-input') {
      window.mcpApp.toolInput = params.arguments;
      window.dispatchEvent(new CustomEvent('mcp:tool-input', { detail: params }));
    }
    if (method === 'ui/notifications/tool-result') {
      window.mcpApp.toolResult = params;
      window.dispatchEvent(new CustomEvent('mcp:tool-result', { detail: params }));
    }
    if (method === 'ui/host-context-change') {
      Object.assign(hostContext, params);
      window.mcpApp.hostContext = hostContext;
      window.dispatchEvent(new CustomEvent('mcp:context-change', { detail: params }));
    }
    // SEP-1865: Tool was cancelled
    if (method === 'ui/tool-cancelled') {
      window.dispatchEvent(new CustomEvent('mcp:tool-cancelled', { detail: params }));
    }
    if (method === 'ui/resource-teardown') {
      window.dispatchEvent(new CustomEvent('mcp:teardown', { detail: params }));
    }
  });

  // Initialize with host
  sendRequest('ui/initialize', {
    capabilities: {},
    clientInfo: { name: 'MCP App Widget', version: '1.0.0' },
    protocolVersion: '2025-06-18',
  }).then((result) => {
    hostContext = result.hostContext || {};
    window.mcpApp.hostContext = hostContext;
    
    // Notify host that we're initialized
    sendNotification('ui/notifications/initialized', {});
  }).catch((err) => {
    console.error('[MCP App] Initialization failed:', err);
  });

  // Public API - SEP-1865 compliant
  window.mcpApp = {
    toolInput: ${JSON.stringify(toolInput ?? null)},
    toolResult: ${JSON.stringify(toolOutput ?? null)},
    hostContext: {},

    // Call another MCP tool
    async callTool(name, args = {}) {
      return sendRequest('tools/call', { name, arguments: args });
    },

    // Read an MCP resource
    async readResource(uri) {
      return sendRequest('resources/read', { uri });
    },

    // Open external link
    async openLink(url) {
      return sendRequest('ui/open-link', { url });
    },

    // Send message to chat
    async sendMessage(text) {
      return sendRequest('ui/message', {
        role: 'user',
        content: { type: 'text', text }
      });
    },

    // Notify host of size change
    resize(width, height) {
      sendNotification('ui/size-change', { width, height });
    },
  };

  // NOTE: No window.openai alias - MCP Apps uses window.mcpApp only
  // OpenAI SDK widgets use a different iframe with window.openai

  // Auto-report size changes
  if (typeof ResizeObserver !== 'undefined') {
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === document.body) {
          const { width, height } = entry.contentRect;
          window.mcpApp.resize(Math.round(width), Math.round(height));
        }
      }
    });
    
    if (document.body) {
      resizeObserver.observe(document.body);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        resizeObserver.observe(document.body);
      });
    }
  }
})();
</script>
`;
}

export default apps;
```

---

## JSON-RPC Communication Protocol

### Message Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                          INITIALIZATION                              │
├─────────────────────────────────────────────────────────────────────┤
│ Sandbox → Host:  ui/notifications/sandbox-ready                      │ ← SEP-1865
│ Host → Sandbox:  ui/notifications/sandbox-resource-ready {html}      │
│ Guest → Host:    ui/initialize {capabilities, clientInfo}            │
│ Host → Guest:    Response {hostContext, hostCapabilities}            │
│ Guest → Host:    ui/notifications/initialized                        │
│ Host → Guest:    ui/notifications/tool-input {arguments}             │
│ Host → Guest:    ui/notifications/tool-result {content, ...}         │
├─────────────────────────────────────────────────────────────────────┤
│                          INTERACTIVE PHASE                           │
├─────────────────────────────────────────────────────────────────────┤
│ Guest → Host:    tools/call {name, arguments}                        │
│ Host → Guest:    Response {content, structuredContent}               │
│ Guest → Host:    ui/message {role, content}                          │
│ Host → Guest:    Response {}                                         │
│ Guest → Host:    ui/open-link {url}                                  │
│ Host → Guest:    Response {}                                         │
│ Guest → Host:    ui/size-change {width, height}                      │ ← Notification
│ Host → Guest:    ui/host-context-change {theme, ...}                 │ ← Notification
├─────────────────────────────────────────────────────────────────────┤
│                          CLEANUP / CANCELLATION                      │
├─────────────────────────────────────────────────────────────────────┤
│ Host → Guest:    ui/tool-cancelled {reason}                          │ ← If cancelled
│ Host → Guest:    ui/resource-teardown {reason}                       │ ← Request (has id)
│ Guest → Host:    Response {}                                         │ ← Wait for response
└─────────────────────────────────────────────────────────────────────┘
```

### JSON-RPC Format

All messages use JSON-RPC 2.0:

```typescript
// Request (with ID)
{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "...", arguments: {...} } }

// Response
{ jsonrpc: "2.0", id: 1, result: { ... } }

// Error Response  
{ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "..." } }

// Notification (no ID)
{ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: {...} } }
```

---

## Host Context & Lifecycle

### Host Context Object

Sent in `ui/initialize` response and `ui/host-context-change`:

```typescript
// Full SEP-1865 HostContext (all fields optional)
interface HostContext {
  // MVP - Implemented in Phase 1
  theme?: "light" | "dark" | "system";
  displayMode?: "inline" | "fullscreen" | "pip" | "carousel";
  viewport?: {
    width: number;
    height: number;
    maxHeight?: number;
    maxWidth?: number;
  };
  locale?: string;           // BCP 47, e.g., "en-US"
  timeZone?: string;         // IANA, e.g., "America/New_York"
  platform?: "web" | "desktop" | "mobile";
  userAgent?: string;

  // Phase 2 - Future extensions (per SEP-1865)
  toolInfo?: {
    id?: RequestId;
    tool: Tool;
  };
  availableDisplayModes?: string[];
  deviceCapabilities?: {
    touch?: boolean;
    hover?: boolean;
  };
  safeAreaInsets?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
}
```

> **Note:** All fields are optional per SEP-1865. MVP implements core fields; Phase 2 adds extended fields.

### Lifecycle Events

Guest UI can listen for events:

```javascript
// Tool input received
window.addEventListener('mcp:tool-input', (e) => {
  console.log('Tool input:', e.detail.arguments);
});

// Tool result received
window.addEventListener('mcp:tool-result', (e) => {
  console.log('Tool result:', e.detail);
});

// Tool was cancelled (per SEP-1865)
window.addEventListener('mcp:tool-cancelled', (e) => {
  console.log('Tool cancelled:', e.detail.reason);
});

// Host context changed (theme, viewport, etc.)
window.addEventListener('mcp:context-change', (e) => {
  console.log('Context changed:', e.detail);
});

// About to be torn down (per SEP-1865 - this is a request, UI should respond)
window.addEventListener('mcp:teardown', (e) => {
  console.log('Teardown reason:', e.detail.reason);
});
```

---

## Capability Advertising

MCP Apps hosts should advertise support for UI capabilities. In Phase 1, we advertise basic support:

### Where to Advertise

When MCPJam connects to an MCP server, it should include the UI capability in the `capabilities` field of the `initialize` request.

**Location:** Update the MCP client initialization (likely in `mcpClientManager` or connection setup)

```typescript
// During MCP server connection initialization (per SEP-1865)
{
  capabilities: {
    // ... existing capabilities ...
    extensions: {
      "io.modelcontextprotocol/ui": {
        mimeTypes: ["text/html+mcp"]  // REQUIRED per SEP-1865
      }
    }
  }
}
```

### Why This Matters

Without capability advertising, MCP servers might not expose their UI resources, since they won't know if the host can render them. By advertising the capability:

1. Servers know MCPJam supports MCP Apps
2. Servers can include `ui/resourceUri` in tool metadata
3. Future feature negotiation can build on this foundation

---

## Implementation Checklist

### Phase 1: Core (MVP)

- [ ] Create `client/src/lib/mcp-apps-utils.ts` - Detection utilities
- [ ] Create `client/src/components/ui/sandboxed-iframe.tsx` - **DRY sandbox component** (future OpenAI migration path)
- [ ] Create `client/src/components/chat-v2/mcp-apps-renderer.tsx` - Main renderer (uses SandboxedIframe)
- [ ] Create `server/routes/mcp/apps.ts` - Server routes (reuses `mcpClientManager.readResource`)
- [ ] Create `server/routes/mcp/sandbox-proxy.html` - **Shared sandbox proxy** (official reference)
- [ ] Update `client/src/components/chat-v2/thread.tsx` - Add detection & routing
- [ ] Update `server/routes/mcp/index.ts` - Mount apps routes + sandbox proxy
- [ ] Advertise `io.modelcontextprotocol/ui` capability (basic)
- [ ] Test with sample MCP server

### Phase 2: Polish

- [ ] Add display mode support (PiP, fullscreen)
- [ ] Add widget state persistence (as MCPJam extension)
- [ ] Add modal support
- [ ] Handle CSP from `_meta.ui.csp`
- [ ] Add `ui/notifications/tool-input-partial` for streaming
- [ ] Full capability negotiation

### Phase 3: Consolidation (Future)

- [ ] When `@mcp-ui/client` releases `AppRenderer`, evaluate swap
- [ ] Migrate `OpenAIAppRenderer` to use `SandboxedIframe` (if MCP Apps and OpenAI converge)
- [ ] Deprecate OpenAI SDK specific code paths (if appropriate)

---

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `client/src/lib/mcp-apps-utils.ts` | **CREATE** | UI type detection utilities |
| `client/src/components/ui/sandboxed-iframe.tsx` | **CREATE** | **DRY** reusable double-iframe sandbox (potential future OpenAI convergence) |
| `client/src/components/chat-v2/mcp-apps-renderer.tsx` | **CREATE** | MCP Apps renderer (uses SandboxedIframe) |
| `server/routes/mcp/apps.ts` | **CREATE** | Server routes - follows same pattern as `openai.ts` |
| `server/routes/mcp/sandbox-proxy.html` | **CREATE** | **Shared** sandbox proxy (official reference) |
| `client/src/components/chat-v2/thread.tsx` | **MODIFY** | Add detection & routing |
| `server/routes/mcp/index.ts` | **MODIFY** | Mount `/apps` routes + `/sandbox-proxy` |

### Reused Components (NOT duplicated)

| Component | Reuse Pattern |
|-----------|---------------|
| `mcpClientManager.readResource()` | Used in `apps.ts` same as `resources.ts` |
| Widget store pattern | Same in-memory Map + TTL cleanup as `openai.ts` |
| Error handling | Same patterns as `openai-app-renderer.tsx` |

### Files NOT Modified

| File | Reason |
|------|--------|
| `client/src/components/chat-v2/openai-app-renderer.tsx` | **Intentionally unchanged** - keep stable, potential Phase 3 migration if MCP Apps and OpenAI converge |
| `server/routes/mcp/resources.ts` | Already has `/read` endpoint - reused via `mcpClientManager` |

---

## Migration Path

### From Current State to MCP Apps

```
Current State
├── OpenAIAppRenderer (openai:* messages, single iframe)
├── UIResourceRenderer (MCP-UI action handlers)
└── No MCP Apps support

After Phase 1 Implementation
├── SandboxedIframe (DRY foundation) ← NEW
├── MCPAppsRenderer (JSON-RPC, uses SandboxedIframe) ← NEW
├── OpenAIAppRenderer (unchanged, legacy)
└── UIResourceRenderer (unchanged, legacy)

After Phase 3 Consolidation
├── SandboxedIframe (shared)
├── MCPAppsRenderer (SEP-1865)
├── OpenAIAppRenderer (migrated to use SandboxedIframe)
└── UIResourceRenderer (maintained)

Future (when @mcp-ui/client AppRenderer is ready)
├── Evaluate: Keep MCPAppsRenderer OR swap for AppRenderer from @mcp-ui/client
├── OpenAIAppRenderer (deprecated path)
└── UIResourceRenderer (deprecated path)
```

### Backward Compatibility

- OpenAI SDK widgets continue to work via existing `OpenAIAppRenderer` (**unchanged**)
- MCP-UI widgets continue to work via existing `UIResourceRenderer` (**unchanged**)
- New MCP Apps widgets use new `MCPAppsRenderer` with `SandboxedIframe`
- **No cross-contamination**: MCP Apps uses `window.mcpApp`, OpenAI uses `window.openai` (different iframes)
- `SandboxedIframe` is designed for potential future consolidation but NOT forced on existing code

---

## Testing

### Sample MCP Server Tool Definition

```typescript
// In MCP server's tools/list handler
{
  name: "weather_dashboard",
  description: "Interactive weather dashboard",
  inputSchema: {
    type: "object",
    properties: {
      location: { type: "string" }
    }
  },
  _meta: {
    "ui/resourceUri": "ui://weather/dashboard"  // MCP Apps linkage
  }
}
```

### Sample UI Resource

```typescript
// In MCP server's resources/read handler for "ui://weather/dashboard"
{
  contents: [{
    uri: "ui://weather/dashboard",
    mimeType: "text/html+mcp",  // MCP Apps MIME type
    text: `
      <!DOCTYPE html>
      <html>
      <head><title>Weather</title></head>
      <body>
        <div id="app"></div>
        <script>
          // Wait for MCP App initialization
          window.addEventListener('mcp:tool-input', (e) => {
            document.getElementById('app').innerHTML = 
              '<h1>Weather for ' + e.detail.arguments.location + '</h1>';
          });
          
          window.addEventListener('mcp:tool-result', (e) => {
            const data = e.detail.structuredContent || e.detail;
            document.getElementById('app').innerHTML += 
              '<p>Temperature: ' + data.temperature + '°F</p>';
          });
        </script>
      </body>
      </html>
    `,
    _meta: {
      ui: {
        csp: {
          connectDomains: ["https://api.weather.com"]
        }
      }
    }
  }]
}
```

---

## Questions & Decisions

| Question | Decision |
|----------|----------|
| Widget state persistence? | Keep as MCPJam extension (`setWidgetState`) |
| Display modes (PiP/fullscreen)? | Keep as MCPJam extension |
| Modal support? | Keep as MCPJam extension |
| Capability advertising? | **Yes in Phase 1** - Basic `io.modelcontextprotocol/ui` capability |
| `window.openai` alias in MCP Apps? | **No** - Different iframes, no cross-contamination |
| DRY `SandboxedIframe` component? | **Yes** - Potential future OpenAI convergence path |
| When to swap for `@mcp-ui/client` AppRenderer? | After PR #147 merges and adds direct HTML support |
| When to migrate OpenAIAppRenderer? | Only if MCP Apps and OpenAI SDK converge |

---

## References

- [SEP-1865: MCP Apps Specification](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1865)
- [MCP-UI PR #147: React Renderer](https://github.com/MCP-UI-Org/mcp-ui/pull/147)
- [modelcontextprotocol/ext-apps SDK](https://github.com/modelcontextprotocol/ext-apps)
- [MCP-UI Documentation](https://mcpui.dev/)
- [MCPJam OpenAI SDK Architecture](./openai-sdk-architecture.mdx)

