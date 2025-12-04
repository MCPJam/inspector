/**
 * PlaygroundEmulator
 *
 * Central widget rendering area with:
 * - Device frame selector (mobile/tablet/desktop)
 * - Display mode selector (inline/pip/fullscreen)
 * - ChatGPTSandboxedIframe with configured globals
 * - Handles all openai:* postMessage events
 * - ChatGPT-style invoking/invoked status header
 */

import { useRef, useCallback, useEffect, useState } from "react";
import {
  LayoutTemplate,
  Loader2,
  AlertCircle,
  ChevronDown,
  Braces,
  Server,
  X,
} from "lucide-react";
import {
  ChatGPTSandboxedIframe,
  ChatGPTSandboxedIframeHandle,
} from "../ui/chatgpt-sandboxed-iframe";
import { useUiLogStore, extractMethod } from "@/stores/ui-log-store";
import type { DeviceType, DisplayMode, PlaygroundGlobals, FollowUpMessage } from "@/stores/ui-playground-store";
import { UserMessageBubble } from "../chat-v2/user-message-bubble";

interface DeviceConfig {
  width: number;
  height: number;
  label: string;
}

const DEVICE_CONFIGS: Record<DeviceType, DeviceConfig> = {
  mobile: {
    width: 430,
    height: 932,
    label: "Mobile (430×932)",
  },
  tablet: {
    width: 820,
    height: 1180,
    label: "Tablet (820×1180)",
  },
  desktop: {
    width: 1280,
    height: 800,
    label: "Desktop (1280×800)",
  },
};

interface ToolInvocationMessages {
  invoking?: string;
  invoked?: string;
}

interface PlaygroundEmulatorProps {
  serverId: string;
  serverName: string | null;
  toolCallId: string | null;
  toolName: string | null;
  widgetUrl: string | null;
  isWidgetTool: boolean;
  isExecuting: boolean;
  executionError: string | null;
  hasExecuted: boolean;
  invocationMessages: ToolInvocationMessages | null;
  deviceType: DeviceType;
  displayMode: DisplayMode;
  globals: PlaygroundGlobals;
  followUpMessages: FollowUpMessage[];
  onDeviceTypeChange: (type: DeviceType) => void;
  onDisplayModeChange: (mode: DisplayMode) => void;
  onWidgetStateChange: (state: unknown) => void;
  onCspViolation: (violation: { directive: string; blockedUri: string; sourceFile?: string; lineNumber?: number }) => void;
  onCallTool: (toolName: string, params: Record<string, unknown>) => Promise<unknown>;
  onSendFollowUp: (message: string) => void;
  onClearFollowUpMessages: () => void;
}

export function PlaygroundEmulator({
  serverId,
  serverName,
  toolCallId,
  toolName,
  widgetUrl,
  isWidgetTool,
  isExecuting,
  executionError,
  hasExecuted,
  invocationMessages,
  deviceType,
  displayMode,
  globals,
  followUpMessages,
  onDeviceTypeChange,
  onDisplayModeChange,
  onWidgetStateChange,
  onCspViolation,
  onCallTool,
  onSendFollowUp,
  onClearFollowUpMessages,
}: PlaygroundEmulatorProps) {
  const sandboxRef = useRef<ChatGPTSandboxedIframeHandle>(null);
  const addUiLog = useUiLogStore((s) => s.addLog);
  const [isReady, setIsReady] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);

  const deviceConfig = DEVICE_CONFIGS[deviceType];

  // Post message to widget
  const postToWidget = useCallback(
    (data: unknown) => {
      addUiLog({
        widgetId: toolCallId || "playground",
        serverId,
        direction: "host-to-ui",
        protocol: "openai-apps",
        method: extractMethod(data, "openai-apps"),
        message: data,
      });
      sandboxRef.current?.postMessage(data);
    },
    [addUiLog, toolCallId, serverId]
  );

  // Handle messages from widget
  const handleMessage = useCallback(
    async (event: MessageEvent) => {
      const data = event.data;
      if (!data?.type?.startsWith?.("openai:")) return;

      // Log all incoming messages
      addUiLog({
        widgetId: toolCallId || "playground",
        serverId,
        direction: "ui-to-host",
        protocol: "openai-apps",
        method: extractMethod(data, "openai-apps"),
        message: data,
      });

      switch (data.type) {
        case "openai:resize": {
          // Ignored - we use fixed device dimensions
          break;
        }

        case "openai:setWidgetState": {
          onWidgetStateChange(data.state);
          break;
        }

        case "openai:callTool": {
          const callId = data.callId;
          const calledToolName = data.toolName;
          try {
            const result = await onCallTool(
              calledToolName,
              data.args || data.params || {}
            );
            postToWidget({
              type: "openai:callTool:response",
              callId,
              result,
            });
          } catch (err) {
            postToWidget({
              type: "openai:callTool:response",
              callId,
              error: err instanceof Error ? err.message : "Unknown error",
            });
          }
          break;
        }

        case "openai:sendFollowup": {
          if (data.message) {
            const message =
              typeof data.message === "string"
                ? data.message
                : data.message.prompt || JSON.stringify(data.message);
            onSendFollowUp(message);
          }
          break;
        }

        case "openai:requestDisplayMode": {
          const requestedMode = data.mode || "inline";
          // On mobile, pip requests convert to fullscreen
          const isMobile = deviceType === "mobile";
          const actualMode =
            isMobile && requestedMode === "pip" ? "fullscreen" : requestedMode;
          onDisplayModeChange(actualMode);
          postToWidget({
            type: "openai:set_globals",
            globals: { displayMode: actualMode },
          });
          break;
        }

        case "openai:requestClose": {
          onDisplayModeChange("inline");
          break;
        }

        case "openai:csp-violation": {
          onCspViolation({
            directive: data.directive,
            blockedUri: data.blockedUri,
            sourceFile: data.sourceFile,
            lineNumber: data.lineNumber,
          });
          break;
        }

        case "openai:openExternal": {
          if (data.href && typeof data.href === "string") {
            const href = data.href;
            // Block localhost URLs for security
            if (
              href.startsWith("http://localhost") ||
              href.startsWith("http://127.0.0.1")
            )
              break;
            window.open(href, "_blank", "noopener,noreferrer");
          }
          break;
        }
      }
    },
    [
      addUiLog,
      toolCallId,
      serverId,
      deviceType,
      onWidgetStateChange,
      onDisplayModeChange,
      onCspViolation,
      onCallTool,
      onSendFollowUp,
      postToWidget,
    ]
  );

  // Push globals to widget when they change
  useEffect(() => {
    if (!isReady) return;
    postToWidget({
      type: "openai:set_globals",
      globals: {
        theme: globals.theme,
        displayMode: globals.displayMode,
        locale: globals.locale,
        userAgent: {
          device: { type: globals.deviceType },
          capabilities: {
            hover: globals.deviceType === "desktop",
            touch: globals.deviceType !== "desktop",
          },
        },
      },
    });
  }, [isReady, globals, postToWidget]);

  // Invocation status header component
  const InvocationHeader = () => {
    if (!toolName) return null;

    const showInvoking = isExecuting;
    const showInvoked = hasExecuted && !isExecuting;

    if (!showInvoking && !showInvoked) return null;

    // Use custom messages from metadata if available
    const invokingMessage = invocationMessages?.invoking;
    const invokedMessage = invocationMessages?.invoked;

    return (
      <div className="px-4 py-3 border-b border-border bg-background">
        {/* Status Line */}
        <button
          onClick={() => showInvoked && setIsCollapsed(!isCollapsed)}
          className={`flex items-center gap-2 text-sm text-foreground w-full text-left ${
            showInvoked ? "cursor-pointer hover:opacity-80" : "cursor-default"
          }`}
          disabled={!showInvoked}
        >
          <Braces className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          {showInvoking ? (
            <>
              {invokingMessage ? (
                <span>{invokingMessage}</span>
              ) : (
                <>
                  <span>Invoking</span>
                  <code className="text-primary font-mono">{toolName}</code>
                </>
              )}
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground ml-auto" />
            </>
          ) : (
            <>
              {invokedMessage ? (
                <span>{invokedMessage}</span>
              ) : (
                <>
                  <span>Invoked</span>
                  <code className="text-primary font-mono">{toolName}</code>
                </>
              )}
              <ChevronDown
                className={`h-4 w-4 text-muted-foreground ml-auto transition-transform ${
                  isCollapsed ? "-rotate-90" : ""
                }`}
              />
            </>
          )}
        </button>

        {/* Server Name */}
        {serverName && (
          <div className="flex items-center gap-2 mt-2 ml-6">
            <div className="w-5 h-5 rounded bg-primary/20 flex items-center justify-center flex-shrink-0">
              <Server className="h-3 w-3 text-primary" />
            </div>
            <span className="text-sm text-muted-foreground">{serverName}</span>
          </div>
        )}
      </div>
    );
  };

  // Render loading/error states
  if (!toolName) {
    return (
      <div className="h-full flex items-center justify-center bg-muted/20">
        <div className="text-center">
          <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mx-auto mb-3">
            <LayoutTemplate className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="text-xs font-semibold text-foreground mb-1">
            Select a tool to preview
          </p>
          <p className="text-xs text-muted-foreground">
            Execute a ChatGPT App tool to see the widget here
          </p>
        </div>
      </div>
    );
  }

  if (isExecuting) {
    return (
      <div className="h-full flex flex-col bg-muted/10">
        <InvocationHeader />
        {/* Skeleton Widget Area */}
        <div className="flex-1 overflow-auto p-4 flex items-start justify-center">
          <div
            className="bg-muted/30 overflow-hidden transition-all duration-300 animate-pulse border border-border rounded-lg"
            style={{
              width: `${deviceConfig.width}px`,
              height: `${deviceConfig.height}px`,
              maxWidth: "100%",
              maxHeight: "100%",
            }}
          />
        </div>
      </div>
    );
  }

  if (executionError) {
    return (
      <div className="h-full flex flex-col bg-muted/10">
        <InvocationHeader />
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center max-w-md">
            <div className="w-12 h-12 bg-destructive/10 rounded-full flex items-center justify-center mx-auto mb-3">
              <AlertCircle className="h-5 w-5 text-destructive" />
            </div>
            <p className="text-xs font-semibold text-foreground mb-1">
              Execution failed
            </p>
            <p className="text-xs text-destructive break-words">{executionError}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!isWidgetTool && hasExecuted) {
    return (
      <div className="h-full flex flex-col bg-muted/10">
        <InvocationHeader />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mx-auto mb-3">
              <LayoutTemplate className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-xs font-semibold text-foreground mb-1">
              Not a widget tool
            </p>
            <p className="text-xs text-muted-foreground max-w-xs">
              This tool doesn't return a ChatGPT App widget. Check the Output tab
              for results.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!widgetUrl && hasExecuted && isWidgetTool) {
    return (
      <div className="h-full flex flex-col bg-muted/10">
        <InvocationHeader />
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-8 w-8 text-muted-foreground animate-spin mx-auto mb-3" />
          <p className="text-xs font-semibold text-foreground mb-1">
            Preparing widget...
          </p>
        </div>
      </div>
    );
  }

  // Show empty state if not yet executed
  if (!hasExecuted) {
    return (
      <div className="h-full flex items-center justify-center bg-muted/20">
        <div className="text-center">
          <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mx-auto mb-3">
            <LayoutTemplate className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="text-xs font-semibold text-foreground mb-1">
            Ready to execute
          </p>
          <p className="text-xs text-muted-foreground">
            Click Execute or press ⌘+Enter to run the tool
          </p>
        </div>
      </div>
    );
  }

  const isFullscreen = displayMode === "fullscreen";
  const isPip = displayMode === "pip";

  // Fullscreen mode: expand within container (no device frame, fills available space)
  if (isFullscreen) {
    return (
      <div className="h-full flex flex-col bg-background relative">
        {/* Close button */}
        <button
          onClick={() => onDisplayModeChange("inline")}
          className="absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md bg-background/80 hover:bg-background border border-border/50 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          aria-label="Close fullscreen"
          title="Close fullscreen"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Widget takes full space */}
        <div className="flex-1 min-h-0">
          <ChatGPTSandboxedIframe
            ref={sandboxRef}
            url={widgetUrl!}
            onMessage={handleMessage}
            onReady={() => setIsReady(true)}
            title={`ChatGPT App Widget: ${toolName}`}
            className="w-full h-full bg-background"
            style={{ height: "100%" }}
          />
        </div>

        {/* Minimal footer with template URL */}
        <div className="px-4 py-2 border-t border-border bg-background text-[11px] text-muted-foreground/70">
          Template: <code>{widgetUrl}</code>
        </div>
      </div>
    );
  }

  // PiP mode: floating card at top of container
  if (isPip) {
    return (
      <div className="h-full flex flex-col bg-muted/10 relative">
        {/* Floating PiP card at top */}
        <div className="absolute top-4 left-4 right-4 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 shadow-xl border border-border/60 rounded-xl p-3">
          {/* Close button */}
          <button
            onClick={() => onDisplayModeChange("inline")}
            className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md bg-background/80 hover:bg-background border border-border/50 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            aria-label="Close PiP"
            title="Close PiP"
          >
            <X className="w-4 h-4" />
          </button>

          <ChatGPTSandboxedIframe
            ref={sandboxRef}
            url={widgetUrl!}
            onMessage={handleMessage}
            onReady={() => setIsReady(true)}
            title={`ChatGPT App Widget: ${toolName}`}
            className="w-full border border-border/40 rounded-md bg-background"
            style={{ height: "400px" }}
          />

          <div className="mt-2 text-[11px] text-muted-foreground/70">
            Template: <code>{widgetUrl}</code>
          </div>
        </div>
      </div>
    );
  }

  // Inline mode: render within the emulator panel with device frame
  return (
    <div className="h-full flex flex-col bg-muted/10">
      {/* Invocation Header */}
      <InvocationHeader />

      {/* Collapsible Content */}
      {!isCollapsed && (
        <>
          {/* Widget Area */}
          <div className="flex-1 overflow-auto p-4 flex flex-col items-center gap-4">
            <div
              className="bg-background overflow-hidden transition-all duration-300 border border-border rounded-lg flex-shrink-0"
              style={{
                width: `${deviceConfig.width}px`,
                height: `${deviceConfig.height}px`,
                maxWidth: "100%",
                maxHeight: "100%",
              }}
            >
              <ChatGPTSandboxedIframe
                ref={sandboxRef}
                url={widgetUrl!}
                onMessage={handleMessage}
                onReady={() => setIsReady(true)}
                title={`ChatGPT App Widget: ${toolName}`}
                className="w-full h-full bg-background"
              />
            </div>

            {/* Follow-up Messages */}
            {followUpMessages.length > 0 && (
              <div className="w-full max-w-4xl space-y-3">
                <div className="flex items-center justify-between px-1">
                  <span className="text-xs text-muted-foreground font-medium">
                    Follow-up Messages ({followUpMessages.length})
                  </span>
                  <button
                    onClick={onClearFollowUpMessages}
                    className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Clear all
                  </button>
                </div>
                {followUpMessages.map((msg) => (
                  <UserMessageBubble key={msg.id} className="animate-in slide-in-from-bottom-2 fade-in duration-200">
                    <p className="whitespace-pre-wrap break-words">{msg.text}</p>
                  </UserMessageBubble>
                ))}
              </div>
            )}
          </div>

          {/* Footer Info */}
          <div className="px-4 py-2 border-t border-border bg-background flex items-center justify-between text-[10px] text-muted-foreground">
            <span>
              {deviceConfig.width}×{deviceConfig.height} | {displayMode}
            </span>
            <span>{toolName}</span>
          </div>
        </>
      )}
    </div>
  );
}
