/**
 * MCPAppsRenderer - SEP-1865 MCP Apps Renderer
 *
 * Renders MCP Apps widgets using the SEP-1865 protocol:
 * - JSON-RPC 2.0 over postMessage
 * - Double-iframe sandbox architecture
 * - tools/call, resources/read, ui/message, ui/open-link support
 *
 * Uses SandboxedIframe for DRY double-iframe setup.
 */

import { useRef, useState, useEffect, useCallback } from "react";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { X } from "lucide-react";
import {
  SandboxedIframe,
  SandboxedIframeHandle,
} from "@/components/ui/sandboxed-iframe";
import { useUiLogStore, extractMethod } from "@/stores/ui-log-store";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";

// Injected by Vite at build time from package.json
declare const __APP_VERSION__: string;

type DisplayMode = "inline" | "pip" | "fullscreen";
type ToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error";

// CSP metadata type per SEP-1865
interface UIResourceCSP {
  connectDomains?: string[];
  resourceDomains?: string[];
}

interface MCPAppsRendererProps {
  serverId: string;
  toolCallId: string;
  toolName: string;
  toolState?: ToolState;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  resourceUri: string;
  toolMetadata?: Record<string, unknown>;
  onSendFollowUp?: (text: string) => void;
  onCallTool?: (
    toolName: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  onWidgetStateChange?: (toolCallId: string, state: unknown) => void;
  pipWidgetId?: string | null;
  onRequestPip?: (toolCallId: string) => void;
  onExitPip?: (toolCallId: string) => void;
}

interface JSONRPCMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export function MCPAppsRenderer({
  serverId,
  toolCallId,
  toolName,
  toolState,
  toolInput,
  toolOutput,
  resourceUri,
  onSendFollowUp,
  onCallTool,
  pipWidgetId,
  onExitPip,
}: MCPAppsRendererProps) {
  const sandboxRef = useRef<SandboxedIframeHandle>(null);
  const themeMode = usePreferencesStore((s) => s.themeMode);

  const [displayMode, setDisplayMode] = useState<DisplayMode>("inline");
  const [contentHeight, setContentHeight] = useState<number>(400);
  const [maxHeight] = useState<number>(600);
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [widgetHtml, setWidgetHtml] = useState<string | null>(null);
  const [widgetCsp, setWidgetCsp] = useState<UIResourceCSP | undefined>(undefined);

  const pendingRequests = useRef<
    Map<
      number | string,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
      }
    >
  >(new Map());

  // Fetch widget HTML when tool output is available
  useEffect(() => {
    if (toolState !== "output-available") return;
    if (widgetHtml) return;

    const fetchWidgetHtml = async () => {
      try {
        // Store widget data first (same pattern as openai.ts)
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
            protocol: "mcp-apps",
          }),
        });

        if (!storeResponse.ok) {
          throw new Error(
            `Failed to store widget: ${storeResponse.statusText}`,
          );
        }

        // Fetch widget content with CSP metadata (SEP-1865)
        const contentResponse = await fetch(
          `/api/mcp/apps/widget-content/${toolCallId}`,
        );
        if (!contentResponse.ok) {
          const errorData = await contentResponse.json().catch(() => ({}));
          throw new Error(
            errorData.error || `Failed to fetch widget: ${contentResponse.statusText}`,
          );
        }

        const { html, csp } = await contentResponse.json();
        setWidgetHtml(html);
        setWidgetCsp(csp);
      } catch (err) {
        setLoadError(
          err instanceof Error ? err.message : "Failed to prepare widget",
        );
      }
    };

    fetchWidgetHtml();
  }, [
    toolState,
    toolCallId,
    widgetHtml,
    serverId,
    resourceUri,
    toolInput,
    toolOutput,
    toolName,
    themeMode,
  ]);

  // UI logging
  const addUiLog = useUiLogStore((s) => s.addLog);

  // Widget debug store
  const setWidgetDebugInfo = useWidgetDebugStore((s) => s.setWidgetDebugInfo);
  const setWidgetGlobals = useWidgetDebugStore((s) => s.setWidgetGlobals);

  // Initialize widget debug info
  useEffect(() => {
    setWidgetDebugInfo(toolCallId, {
      toolName,
      protocol: "mcp-apps",
      widgetState: null, // MCP Apps don't have widget state in the same way
      globals: {
        theme: themeMode,
        displayMode,
        maxHeight,
        locale: navigator.language,
      },
    });
  }, [
    toolCallId,
    toolName,
    setWidgetDebugInfo,
    themeMode,
    displayMode,
    maxHeight,
  ]);

  // Update globals in debug store when they change
  useEffect(() => {
    setWidgetGlobals(toolCallId, {
      theme: themeMode,
      displayMode,
      maxHeight,
    });
  }, [toolCallId, themeMode, displayMode, maxHeight, setWidgetGlobals]);

  // JSON-RPC helpers
  const postMessage = useCallback(
    (data: unknown) => {
      // Log outgoing message
      addUiLog({
        widgetId: toolCallId,
        serverId,
        direction: "host-to-ui",
        protocol: "mcp-apps",
        method: extractMethod(data, "mcp-apps"),
        message: data,
      });
      sandboxRef.current?.postMessage(data);
    },
    [addUiLog, toolCallId, serverId],
  );

  const sendNotification = useCallback(
    (method: string, params: unknown) => {
      postMessage({ jsonrpc: "2.0", method, params });
    },
    [postMessage],
  );

  const sendResponse = useCallback(
    (
      id: number | string,
      result?: unknown,
      error?: { code: number; message: string },
    ) => {
      postMessage({
        jsonrpc: "2.0",
        id,
        ...(error ? { error } : { result: result ?? {} }),
      });
    },
    [postMessage],
  );

  // Handle messages from guest UI (via SandboxedIframe)
  const handleMessage = useCallback(
    async (event: MessageEvent) => {
      const { jsonrpc, id, method, params, result, error } =
        event.data as JSONRPCMessage;

      // Not a JSON-RPC message
      if (jsonrpc !== "2.0") return;

      // Log incoming message
      addUiLog({
        widgetId: toolCallId,
        serverId,
        direction: "ui-to-host",
        protocol: "mcp-apps",
        method: extractMethod(event.data, "mcp-apps"),
        message: event.data,
      });

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
            // Respond with host context (per SEP-1865)
            sendResponse(id, {
              protocolVersion: "2025-11-25",
              hostCapabilities: {},
              hostInfo: { name: "mcpjam-inspector", version: __APP_VERSION__ },
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
              sendResponse(id, undefined, {
                code: -32601,
                message: "Tool calls not supported",
              });
              break;
            }
            try {
              const callParams = params as {
                name: string;
                arguments?: Record<string, unknown>;
              };
              const result = await onCallTool(
                callParams.name,
                callParams.arguments || {},
              );
              sendResponse(id, result);
            } catch (err) {
              sendResponse(id, undefined, {
                code: -32000,
                message:
                  err instanceof Error ? err.message : "Tool call failed",
              });
            }
            break;
          }

          case "resources/read": {
            try {
              const readParams = params as { uri: string };
              const response = await fetch(`/api/mcp/resources/read`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ serverId, uri: readParams.uri }),
              });
              const result = await response.json();
              // API returns { content: { contents: [...] } }, SDK expects { contents: [...] }
              sendResponse(id, result.content);
            } catch (err) {
              sendResponse(id, undefined, {
                code: -32000,
                message:
                  err instanceof Error ? err.message : "Resource read failed",
              });
            }
            break;
          }

          case "ui/open-link": {
            const linkParams = params as { url?: string };
            if (linkParams.url) {
              window.open(linkParams.url, "_blank", "noopener,noreferrer");
            }
            sendResponse(id, {});
            break;
          }

          case "ui/message": {
            // SEP-1865 specifies: { role: "user", content: { type: "text", text: "..." } }
            // SDK sends array:    { role: "user", content: [{ type: "text", text: "..." }] }
            // Support both formats for compatibility
            const messageParams = params as {
              role?: string;
              content?:
                | { type: string; text?: string }
                | Array<{ type: string; text?: string }>;
            };
            const textContent = Array.isArray(messageParams.content)
              ? messageParams.content.find((c) => c.type === "text")?.text
              : messageParams.content?.type === "text"
                ? messageParams.content.text
                : undefined;
            if (onSendFollowUp && textContent) {
              onSendFollowUp(textContent);
            }
            sendResponse(id, {});
            break;
          }

          default:
            sendResponse(id, undefined, {
              code: -32601,
              message: `Method not found: ${method}`,
            });
        }
        return;
      }

      // Handle notifications from guest UI
      if (method && id === undefined) {
        switch (method) {
          case "ui/notifications/initialized":
            // Guest UI finished initialization, send tool data
            if (toolInput) {
              sendNotification("ui/notifications/tool-input", {
                arguments: toolInput,
              });
            }
            if (toolOutput && toolState === "output-available") {
              sendNotification("ui/notifications/tool-result", toolOutput);
            }
            break;

          case "ui/size-change": {
            const sizeParams = params as { height?: number };
            if (typeof sizeParams.height === "number") {
              setContentHeight(Math.min(sizeParams.height, maxHeight));
            }
            break;
          }

          case "notifications/message":
            console.log("[MCP Apps] Guest log:", params);
            break;
        }
      }
    },
    [
      themeMode,
      displayMode,
      contentHeight,
      maxHeight,
      onCallTool,
      onSendFollowUp,
      serverId,
      toolCallId,
      toolInput,
      toolOutput,
      toolState,
      sendResponse,
      sendNotification,
      addUiLog,
    ],
  );

  // Track previous theme to avoid sending redundant notifications on mount
  // (theme is already included in McpUiInitializeResult.hostContext)
  const prevThemeRef = useRef<string | null>(null);

  // Send theme updates only when theme actually changes (not on initial mount)
  useEffect(() => {
    if (!isReady) return;

    // Skip initial mount - theme was already sent in initialize response
    if (prevThemeRef.current === null) {
      prevThemeRef.current = themeMode;
      return;
    }

    // Only send notification if theme actually changed
    if (prevThemeRef.current !== themeMode) {
      prevThemeRef.current = themeMode;
      sendNotification("ui/notifications/host-context-changed", {
        theme: themeMode,
      });
    }
  }, [themeMode, isReady, sendNotification]);

  // Loading states (same patterns as openai-app-renderer.tsx)
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
    containerClassName =
      "fixed inset-0 z-50 w-full h-full bg-background flex flex-col";
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
        csp={widgetCsp}
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
