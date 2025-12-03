import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { X, Loader2 } from "lucide-react";
import { useUiLogStore, extractMethod } from "@/stores/ui-log-store";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";
import {
  OpenAISandboxedIframe,
  OpenAISandboxedIframeHandle,
  OpenAIWidgetCSP,
} from "@/components/ui/openai-sandboxed-iframe";

type DisplayMode = "inline" | "pip" | "fullscreen";

type ToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error"
  | string;

interface OpenAIAppRendererProps {
  serverId: string;
  toolCallId?: string;
  toolName?: string;
  toolState?: ToolState;
  toolInput?: Record<string, any> | null;
  toolOutput?: unknown;
  toolMetadata?: Record<string, any>;
  onSendFollowUp?: (text: string) => void;
  onCallTool?: (toolName: string, params: Record<string, any>) => Promise<any>;
  onWidgetStateChange?: (toolCallId: string, state: any) => void;
  pipWidgetId?: string | null;
  onRequestPip?: (toolCallId: string) => void;
  onExitPip?: (toolCallId: string) => void;
}

export function OpenAIAppRenderer({
  serverId,
  toolCallId,
  toolName,
  toolState,
  toolInput: toolInputProp,
  toolOutput: toolOutputProp,
  toolMetadata,
  onSendFollowUp,
  onCallTool,
  onWidgetStateChange,
  pipWidgetId,
  onRequestPip,
  onExitPip,
}: OpenAIAppRendererProps) {
  const sandboxRef = useRef<OpenAISandboxedIframeHandle>(null);
  const modalIframeRef = useRef<HTMLIFrameElement>(null);
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("inline");
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const [contentHeight, setContentHeight] = useState<number>(320);
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [widgetHtml, setWidgetHtml] = useState<string | null>(null);
  const [widgetCsp, setWidgetCsp] = useState<OpenAIWidgetCSP | undefined>(
    undefined
  );
  const [widgetClosed, setWidgetClosed] = useState(false);
  const [isStoringWidget, setIsStoringWidget] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalParams, setModalParams] = useState<Record<string, any>>({});
  const [modalTitle, setModalTitle] = useState<string>("");
  const [modalUrl, setModalUrl] = useState<string | null>(null);
  const previousWidgetStateRef = useRef<string | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const resolvedToolCallId = useMemo(
    () => toolCallId ?? `${toolName || "openai-app"}-${Date.now()}`,
    [toolCallId, toolName],
  );

  // Extract outputTemplate from tool metadata
  const outputTemplate = useMemo(
    () => toolMetadata?.["openai/outputTemplate"],
    [toolMetadata],
  );

  // Extract structuredContent from tool output
  const structuredContent = useMemo(() => {
    if (
      toolOutputProp &&
      typeof toolOutputProp === "object" &&
      toolOutputProp !== null &&
      "structuredContent" in (toolOutputProp as Record<string, unknown>)
    ) {
      return (toolOutputProp as Record<string, unknown>).structuredContent;
    }
    return null;
  }, [toolOutputProp]);

  // Extract toolResponseMetadata from _meta field
  const toolResponseMetadata = useMemo(() => {
    if (
      toolOutputProp &&
      typeof toolOutputProp === "object" &&
      toolOutputProp !== null &&
      "_meta" in toolOutputProp
    ) {
      return (toolOutputProp as Record<string, unknown>)._meta;
    }
    if (
      toolOutputProp &&
      typeof toolOutputProp === "object" &&
      toolOutputProp !== null &&
      "meta" in toolOutputProp
    ) {
      return (toolOutputProp as Record<string, unknown>).meta;
    }
    return null;
  }, [toolOutputProp, structuredContent]);

  const resolvedToolInput = useMemo(
    () => (toolInputProp as Record<string, any>) ?? {},
    [toolInputProp],
  );

  const resolvedToolOutput = useMemo(
    () => structuredContent ?? toolOutputProp ?? null,
    [structuredContent, toolOutputProp],
  );

  // Store widget data and fetch HTML - ONLY once when tool state is output-available
  useEffect(() => {
    let isCancelled = false;

    // Don't store until tool execution is complete
    if (toolState !== "output-available") {
      return;
    }

    // Already have HTML, don't re-fetch
    if (widgetHtml) {
      return;
    }

    if (!outputTemplate) {
      setWidgetHtml(null);
      setStoreError(null);
      setIsStoringWidget(false);
      return;
    }

    if (!toolName) {
      setWidgetHtml(null);
      setStoreError("Tool name is required");
      setIsStoringWidget(false);
      return;
    }

    const fetchWidgetHtml = async () => {
      setIsStoringWidget(true);
      setStoreError(null);

      try {
        // First, store widget data
        const storeResponse = await fetch("/api/mcp/openai/widget/store", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            serverId,
            uri: outputTemplate,
            toolInput: resolvedToolInput,
            toolOutput: resolvedToolOutput,
            toolResponseMetadata: toolResponseMetadata,
            toolId: resolvedToolCallId,
            toolName: toolName,
            theme: themeMode,
          }),
        });

        if (!storeResponse.ok) {
          throw new Error(
            `Failed to store widget data: ${storeResponse.statusText}`
          );
        }

        if (isCancelled) return;

        // Then fetch HTML + CSP as JSON
        const htmlResponse = await fetch(
          `/api/mcp/openai/widget-html/${resolvedToolCallId}`
        );

        if (!htmlResponse.ok) {
          const errorData = await htmlResponse.json().catch(() => ({}));
          throw new Error(
            errorData.error || `Failed to fetch widget HTML: ${htmlResponse.statusText}`
          );
        }

        const data = await htmlResponse.json();

        if (isCancelled) return;

        // Check if widget should be closed (not rendered)
        if (data.closeWidget) {
          setWidgetClosed(true);
          setIsStoringWidget(false);
          return;
        }

        setWidgetHtml(data.html);
        setWidgetCsp(data.csp);
        // Also store the modal URL for requestModal functionality
        setModalUrl(`/api/mcp/openai/widget/${resolvedToolCallId}`);
      } catch (err) {
        if (isCancelled) return;
        console.error("Error fetching widget HTML:", err);
        setStoreError(
          err instanceof Error ? err.message : "Failed to prepare widget"
        );
      } finally {
        if (!isCancelled) {
          setIsStoringWidget(false);
        }
      }
    };

    fetchWidgetHtml();

    return () => {
      isCancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    toolState,
    resolvedToolCallId,
    widgetHtml,
    outputTemplate,
    toolName,
    serverId,
    resolvedToolInput,
    resolvedToolOutput,
    toolResponseMetadata,
    themeMode,
  ]);

  const appliedHeight = useMemo(() => {
    const baseHeight = contentHeight > 0 ? contentHeight : 320;
    if (typeof maxHeight === "number" && Number.isFinite(maxHeight)) {
      return Math.min(baseHeight, maxHeight);
    }
    return baseHeight;
  }, [contentHeight, maxHeight]);

  const iframeHeight = useMemo(() => {
    if (displayMode === "fullscreen") return "100%";
    if (displayMode === "pip") {
      return pipWidgetId === resolvedToolCallId
        ? "400px"
        : `${appliedHeight}px`;
    }
    return `${appliedHeight}px`;
  }, [appliedHeight, displayMode, pipWidgetId, resolvedToolCallId]);

  // UI logging
  const addUiLog = useUiLogStore((s) => s.addLog);

  // Widget debug store
  const setWidgetDebugInfo = useWidgetDebugStore((s) => s.setWidgetDebugInfo);
  const setWidgetState = useWidgetDebugStore((s) => s.setWidgetState);
  const setWidgetGlobals = useWidgetDebugStore((s) => s.setWidgetGlobals);

  // Initialize widget debug info
  useEffect(() => {
    if (!toolName) return;
    setWidgetDebugInfo(resolvedToolCallId, {
      toolName,
      protocol: "openai-apps",
      widgetState: null,
      globals: {
        theme: themeMode,
        displayMode,
        maxHeight: maxHeight ?? undefined,
        locale: "en-US",
        safeArea: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
        userAgent: {
          device: { type: "desktop" },
          capabilities: { hover: true, touch: false },
        },
      },
    });
  }, [
    resolvedToolCallId,
    toolName,
    setWidgetDebugInfo,
    themeMode,
    displayMode,
    maxHeight,
  ]);

  // Update globals in debug store when they change
  useEffect(() => {
    setWidgetGlobals(resolvedToolCallId, {
      theme: themeMode,
      displayMode,
      maxHeight: maxHeight ?? undefined,
    });
  }, [resolvedToolCallId, themeMode, displayMode, maxHeight, setWidgetGlobals]);

  // Helper to post message to widget via sandbox and log it
  const postToWidget = useCallback(
    (data: unknown, targetModal?: boolean) => {
      addUiLog({
        widgetId: resolvedToolCallId,
        serverId,
        direction: "host-to-ui",
        protocol: "openai-apps",
        method: extractMethod(data, "openai-apps"),
        message: data,
      });

      if (targetModal && modalIframeRef.current?.contentWindow) {
        modalIframeRef.current.contentWindow.postMessage(data, "*");
      } else {
        sandboxRef.current?.postMessage(data);
      }
    },
    [addUiLog, resolvedToolCallId, serverId]
  );

  // Handle messages from sandbox iframe (widget messages are forwarded through sandbox)
  const handleSandboxMessage = useCallback(
    async (event: MessageEvent) => {
      // Log incoming message
      if (event.data?.type) {
        addUiLog({
          widgetId: resolvedToolCallId,
          serverId,
          direction: "ui-to-host",
          protocol: "openai-apps",
          method: extractMethod(event.data, "openai-apps"),
          message: event.data,
        });
      }

      console.log("[OpenAI App] Received message from sandbox:", event.data);

      switch (event.data?.type) {
        case "openai:resize": {
          const rawHeight = Number(event.data.height);
          if (Number.isFinite(rawHeight) && rawHeight > 0) {
            const nextHeight = Math.round(rawHeight);
            setContentHeight((prev) =>
              Math.abs(prev - nextHeight) > 1 ? nextHeight : prev
            );
          }
          break;
        }

        case "openai:setWidgetState": {
          console.log("[OpenAI App] Widget state updated:", event.data.state);

          if (event.data.toolId === resolvedToolCallId) {
            const newState = event.data.state;
            const newStateStr =
              newState === null ? null : JSON.stringify(newState);

            if (newStateStr !== previousWidgetStateRef.current) {
              previousWidgetStateRef.current = newStateStr;
              setWidgetState(resolvedToolCallId, newState);
              onWidgetStateChange?.(resolvedToolCallId, newState);
            }
          }

          // Sync state to modal if open
          if (modalOpen) {
            postToWidget(
              {
                type: "openai:pushWidgetState",
                toolId: resolvedToolCallId,
                state: event.data.state,
              },
              true
            );
          }
          break;
        }

        case "openai:callTool": {
          const callId = event.data.callId;

          if (!onCallTool) {
            console.warn(
              "[OpenAI App] callTool received but handler not available"
            );
            postToWidget({
              type: "openai:callTool:response",
              callId,
              error: "callTool is not supported in this context",
            });
            break;
          }

          try {
            const result = await onCallTool(
              event.data.toolName,
              event.data.args || event.data.params || {}
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
          if (onSendFollowUp && event.data.message) {
            const message =
              typeof event.data.message === "string"
                ? event.data.message
                : event.data.message.prompt ||
                  JSON.stringify(event.data.message);
            console.log("[OpenAI App] Sending followup message:", message);
            onSendFollowUp(message);
          } else {
            console.warn(
              "[OpenAI App] sendFollowup received but handler not available or message missing",
              {
                hasHandler: !!onSendFollowUp,
                message: event.data.message,
              }
            );
          }
          break;
        }

        case "openai:requestDisplayMode": {
          const requestedMode = event.data.mode || "inline";
          // Mobile coerces PiP -> fullscreen per SDK docs
          const isMobile = window.innerWidth < 768;
          const actualMode =
            isMobile && requestedMode === "pip" ? "fullscreen" : requestedMode;

          setDisplayMode(actualMode);

          if (actualMode === "pip") {
            onRequestPip?.(resolvedToolCallId);
          } else if (actualMode === "inline" || actualMode === "fullscreen") {
            if (pipWidgetId === resolvedToolCallId) {
              onExitPip?.(resolvedToolCallId);
            }
          }

          if (typeof event.data.maxHeight === "number") {
            setMaxHeight(event.data.maxHeight);
          } else if (event.data.maxHeight == null) {
            setMaxHeight(null);
          }

          // Notify widget of actual mode (may differ from requested on mobile)
          postToWidget({
            type: "openai:set_globals",
            globals: { displayMode: actualMode },
          });
          break;
        }

        case "openai:requestClose": {
          console.log("[OpenAI App] Widget requested close");
          setDisplayMode("inline");
          if (pipWidgetId === resolvedToolCallId) {
            onExitPip?.(resolvedToolCallId);
          }
          break;
        }

        case "openai:csp-violation": {
          const { directive, blockedUri, sourceFile, lineNumber } = event.data;
          console.warn(
            `[OpenAI Widget CSP] Blocked ${blockedUri} by ${directive}`,
            sourceFile ? `at ${sourceFile}:${lineNumber}` : ""
          );
          // In dev mode, could show a toast, but for now just log
          break;
        }

        case "openai:openExternal": {
          if (event.data.href && typeof event.data.href === "string") {
            window.open(event.data.href, "_blank", "noopener,noreferrer");
          }
          break;
        }

        case "openai:requestModal": {
          setModalTitle(event.data.title || "Modal");
          setModalParams(event.data.params || {});
          setModalOpen(true);
          break;
        }
      }
    },
    [
      onCallTool,
      onSendFollowUp,
      onWidgetStateChange,
      resolvedToolCallId,
      pipWidgetId,
      modalOpen,
      onRequestPip,
      onExitPip,
      addUiLog,
      postToWidget,
      serverId,
      setWidgetState,
    ]
  );

  // Handle messages from modal iframe (uses old direct iframe approach)
  const handleModalMessage = useCallback(
    async (event: MessageEvent) => {
      const modalWindow = modalIframeRef.current?.contentWindow ?? null;
      if (!modalWindow || event.source !== modalWindow) return;

      // Log incoming message
      if (event.data?.type) {
        addUiLog({
          widgetId: resolvedToolCallId,
          serverId,
          direction: "ui-to-host",
          protocol: "openai-apps",
          method: extractMethod(event.data, "openai-apps"),
          message: event.data,
        });
      }

      // Handle widget state sync from modal back to inline
      if (event.data?.type === "openai:setWidgetState") {
        if (event.data.toolId === resolvedToolCallId) {
          const newState = event.data.state;
          setWidgetState(resolvedToolCallId, newState);
          onWidgetStateChange?.(resolvedToolCallId, newState);
          // Sync to inline sandbox
          postToWidget({
            type: "openai:pushWidgetState",
            toolId: resolvedToolCallId,
            state: newState,
          });
        }
      }
    },
    [
      addUiLog,
      resolvedToolCallId,
      serverId,
      setWidgetState,
      onWidgetStateChange,
      postToWidget,
    ]
  );

  // Modal message handler (global listener for modal iframe)
  useEffect(() => {
    window.addEventListener("message", handleModalMessage);
    return () => {
      window.removeEventListener("message", handleModalMessage);
    };
  }, [handleModalMessage]);

  useEffect(() => {
    if (displayMode === "pip" && pipWidgetId !== resolvedToolCallId) {
      setDisplayMode("inline");
    }
  }, [displayMode, pipWidgetId, resolvedToolCallId]);

  // Send global updates to sandbox
  useEffect(() => {
    if (!isReady) return;

    const globals: Record<string, unknown> = { theme: themeMode };
    if (typeof maxHeight === "number" && Number.isFinite(maxHeight)) {
      globals.maxHeight = maxHeight;
    }
    globals.displayMode = displayMode;

    console.log("[OpenAI App] Sending globals update to sandbox:", globals);
    postToWidget({ type: "openai:set_globals", globals });

    // Also send to modal if open
    if (modalOpen) {
      postToWidget({ type: "openai:set_globals", globals }, true);
    }
  }, [themeMode, maxHeight, displayMode, isReady, modalOpen, postToWidget]);

  // Note: Height measurement via contentDocument won't work with cross-origin sandbox.
  // Widget should send openai:resize messages to report its height.

  // Extract tool invocation status from metadata
  const invokingText = toolMetadata?.["openai/toolInvocation/invoking"] as
    | string
    | undefined;
  const invokedText = toolMetadata?.["openai/toolInvocation/invoked"] as
    | string
    | undefined;

  // Tool is executing - show invocation status
  if (toolState === "input-streaming" || toolState === "input-available") {
    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2 flex items-center gap-2">
        <Loader2 className="h-3 w-3 animate-spin" />
        {invokingText || "Executing tool..."}
      </div>
    );
  }

  // Loading state
  if (isStoringWidget) {
    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2 flex items-center gap-2">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading OpenAI App widget...
      </div>
    );
  }

  // Error state
  if (storeError) {
    return (
      <div className="border border-destructive/40 bg-destructive/10 text-destructive text-xs rounded-md px-3 py-2">
        Failed to load widget: {storeError}
        {outputTemplate && (
          <>
            {" "}
            (Template <code>{outputTemplate}</code>)
          </>
        )}
      </div>
    );
  }

  // Widget closed by server
  if (widgetClosed) {
    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
        {invokedText || "Tool completed successfully."}
      </div>
    );
  }

  // No output template
  if (!outputTemplate) {
    if (toolState !== "output-available") {
      return (
        <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
          Widget UI will appear once the tool finishes executing.
        </div>
      );
    }

    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
        Unable to render OpenAI App UI for this tool result.
      </div>
    );
  }

  // No widget HTML yet
  if (!widgetHtml) {
    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2 flex items-center gap-2">
        <Loader2 className="h-3 w-3 animate-spin" />
        Preparing widget...
      </div>
    );
  }

  const isPip = displayMode === "pip" && pipWidgetId === resolvedToolCallId;
  const isFullscreen = displayMode === "fullscreen";

  let containerClassName = "mt-3 space-y-2 relative group";

  if (isFullscreen) {
    containerClassName = [
      "fixed",
      "inset-0",
      "z-50",
      "w-full",
      "h-full",
      "bg-background",
      "flex",
      "flex-col",
    ].join(" ");
  } else if (isPip) {
    containerClassName = [
      "fixed",
      "top-4",
      "inset-x-0",
      "z-40",
      "w-full",
      "max-w-4xl",
      "mx-auto",
      "space-y-2",
      "bg-background/95",
      "backdrop-blur",
      "supports-[backdrop-filter]:bg-background/80",
      "shadow-xl",
      "border",
      "border-border/60",
      "rounded-xl",
      "p-3",
    ].join(" ");
  }

  const shouldShowExitButton = isPip || isFullscreen;

  // Render sandboxed iframe
  return (
    <div className={containerClassName}>
      {shouldShowExitButton && (
        <button
          onClick={() => {
            setDisplayMode("inline");
            onExitPip?.(resolvedToolCallId);
          }}
          className="absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md bg-background/80 hover:bg-background border border-border/50 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          aria-label="Close PiP mode"
          title="Close PiP mode"
        >
          <X className="w-4 h-4" />
        </button>
      )}
      {loadError && (
        <div className="border border-destructive/40 bg-destructive/10 text-destructive text-xs rounded-md px-3 py-2">
          Failed to load widget: {loadError}
        </div>
      )}
      <OpenAISandboxedIframe
        ref={sandboxRef}
        html={widgetHtml}
        csp={widgetCsp}
        onMessage={handleSandboxMessage}
        onReady={() => {
          setIsReady(true);
          setLoadError(null);
        }}
        title={`OpenAI App Widget: ${toolName || "tool"}`}
        className="w-full border border-border/40 rounded-md bg-background"
        style={{
          height: iframeHeight,
          maxHeight: displayMode === "fullscreen" ? "90vh" : undefined,
        }}
      />
      {outputTemplate && (
        <div className="text-[11px] text-muted-foreground/70">
          Template: <code>{outputTemplate}</code>
        </div>
      )}

      {/* Modal uses old direct iframe (same-origin, inspector-specific feature) */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-6xl h-[70vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{modalTitle}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 w-full h-full min-h-0">
            <iframe
              ref={modalIframeRef}
              src={
                modalUrl
                  ? `${modalUrl}?view_mode=modal&view_params=${encodeURIComponent(
                      JSON.stringify(modalParams)
                    )}`
                  : undefined
              }
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
              title={`OpenAI App Modal: ${modalTitle}`}
              className="w-full h-full border-0 rounded-md bg-background"
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
