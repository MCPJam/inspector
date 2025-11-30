import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { X } from "lucide-react";
import { useUiLogStore, extractMethod } from "@/stores/ui-log-store";

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
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const modalIframeRef = useRef<HTMLIFrameElement>(null);
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("inline");
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const [contentHeight, setContentHeight] = useState<number>(320);
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [widgetUrl, setWidgetUrl] = useState<string | null>(null);
  const [isStoringWidget, setIsStoringWidget] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalParams, setModalParams] = useState<Record<string, any>>({});
  const [modalTitle, setModalTitle] = useState<string>("");
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

  // Store widget data and get URL - ONLY once when tool state is output-available
  useEffect(() => {
    let isCancelled = false;

    // Don't store until tool execution is complete
    if (toolState !== "output-available") {
      return;
    }

    // Already have a URL, don't re-store
    if (widgetUrl) {
      return;
    }

    if (!outputTemplate) {
      setWidgetUrl(null);
      setStoreError(null);
      setIsStoringWidget(false);
      return;
    }

    if (!toolName) {
      setWidgetUrl(null);
      setStoreError("Tool name is required");
      setIsStoringWidget(false);
      return;
    }

    const storeWidgetData = async () => {
      setIsStoringWidget(true);
      setStoreError(null);

      try {
        const response = await fetch("/api/mcp/openai/widget/store", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            serverId,
            uri: outputTemplate,
            toolInput: resolvedToolInput,
            toolOutput: resolvedToolOutput,
            toolResponseMetadata: toolResponseMetadata, // Extract _meta from tool response
            toolId: resolvedToolCallId,
            toolName: toolName,
            theme: themeMode,
          }),
        });

        if (!response.ok) {
          throw new Error(
            `Failed to store widget data: ${response.statusText}`,
          );
        }

        if (isCancelled) return;

        // Set the widget URL after successful storage
        const url = `/api/mcp/openai/widget/${resolvedToolCallId}`;
        setWidgetUrl(url);
      } catch (err) {
        if (isCancelled) return;
        console.error("Error storing widget data:", err);
        setStoreError(
          err instanceof Error ? err.message : "Failed to prepare widget",
        );
      } finally {
        if (!isCancelled) {
          setIsStoringWidget(false);
        }
      }
    };

    storeWidgetData();

    return () => {
      isCancelled = true;
    };
    // Store once when state becomes output-available and widgetUrl is not yet set
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    toolState,
    resolvedToolCallId,
    widgetUrl,
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

  // Helper to post message to widget and log it
  const postToWidget = useCallback(
    (target: Window | null, data: unknown) => {
      if (!target) return;
      addUiLog({
        widgetId: resolvedToolCallId,
        serverId,
        direction: "host-to-ui",
        protocol: "openai-apps",
        method: extractMethod(data, "openai-apps"),
        message: data,
      });
      target.postMessage(data, "*");
    },
    [addUiLog, resolvedToolCallId, serverId],
  );

  // Handle messages from iframe
  const handleMessage = useCallback(
    async (event: MessageEvent) => {
      const inlineWindow = iframeRef.current?.contentWindow;
      const modalWindow = modalIframeRef.current?.contentWindow;
      const isFromInline =
        inlineWindow != null && event.source === inlineWindow;
      const isFromModal = modalWindow != null && event.source === modalWindow;

      if (!isFromInline && !isFromModal) return;

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

      console.log("[OpenAI App] Received message from iframe:", event.data);

      switch (event.data?.type) {
        case "openai:resize": {
          const rawHeight = Number(event.data.height);
          if (Number.isFinite(rawHeight) && rawHeight > 0) {
            const nextHeight = Math.round(rawHeight);
            setContentHeight((prev) =>
              Math.abs(prev - nextHeight) > 1 ? nextHeight : prev,
            );
          }
          break;
        }

        case "openai:setWidgetState": {
          // Widget state is already persisted by the iframe script
          console.log("[OpenAI App] Widget state updated:", event.data.state);

          if (onWidgetStateChange && event.data.toolId === resolvedToolCallId) {
            const newState = event.data.state;
            const newStateStr =
              newState === null ? null : JSON.stringify(newState);

            if (newStateStr !== previousWidgetStateRef.current) {
              previousWidgetStateRef.current = newStateStr;
              onWidgetStateChange(resolvedToolCallId, newState);
            }
          }

          const targetWindow = isFromInline
            ? modalWindow
            : isFromModal
              ? inlineWindow
              : null;

          postToWidget(targetWindow, {
            type: "openai:pushWidgetState",
            toolId: resolvedToolCallId,
            state: event.data.state,
          });
          break;
        }

        case "openai:callTool": {
          if (!onCallTool) {
            console.warn(
              "[OpenAI App] callTool received but handler not available",
            );
            postToWidget(event.source as Window | null, {
              type: "openai:callTool:response",
              requestId: event.data.requestId,
              error: "callTool is not supported in this context",
            });
            break;
          }

          try {
            const result = await onCallTool(
              event.data.toolName,
              event.data.params || {},
            );
            postToWidget(event.source as Window | null, {
              type: "openai:callTool:response",
              requestId: event.data.requestId,
              result,
            });
          } catch (err) {
            postToWidget(event.source as Window | null, {
              type: "openai:callTool:response",
              requestId: event.data.requestId,
              error: err instanceof Error ? err.message : "Unknown error",
            });
          }
          break;
        }

        case "openai:sendFollowup": {
          if (onSendFollowUp && event.data.message) {
            // Handle both string and object formats from OpenAI Apps SDK
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
              },
            );
          }
          break;
        }

        case "openai:requestDisplayMode": {
          if (event.data.mode) {
            const mode = event.data.mode;
            setDisplayMode(mode);
            if (mode === "pip") {
              onRequestPip?.(resolvedToolCallId);
            } else if (mode === "inline" || mode === "fullscreen") {
              if (pipWidgetId === resolvedToolCallId) {
                onExitPip?.(resolvedToolCallId);
              }
            }
          }
          if (typeof event.data.maxHeight === "number") {
            setMaxHeight(event.data.maxHeight);
          } else if (event.data.maxHeight == null) {
            setMaxHeight(null);
          }
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
      modalIframeRef,
      onRequestPip,
      onExitPip,
      addUiLog,
      postToWidget,
      serverId,
    ],
  );

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [handleMessage]);

  useEffect(() => {
    if (displayMode === "pip" && pipWidgetId !== resolvedToolCallId) {
      setDisplayMode("inline");
    }
  }, [displayMode, pipWidgetId, resolvedToolCallId]);

  // Send global updates to server
  useEffect(() => {
    if (!isReady) return;

    const postGlobals = (target: HTMLIFrameElement | null) => {
      if (!target?.contentWindow) return;
      const globals: Record<string, unknown> = { theme: themeMode };
      if (typeof maxHeight === "number" && Number.isFinite(maxHeight)) {
        globals.maxHeight = maxHeight;
      }
      globals.displayMode = displayMode;

      console.log("[OpenAI App] Sending globals update to iframe:", globals);
      postToWidget(target.contentWindow, {
        type: "openai:set_globals",
        globals,
      });
    };

    postGlobals(iframeRef.current);
    postGlobals(modalIframeRef.current);
  }, [themeMode, maxHeight, displayMode, isReady, postToWidget]);

  // Kick off an early manual resize measurement while the widget is mounting.
  useEffect(() => {
    if (!isReady) return;

    let attempts = 0;
    const maxAttempts = 12; // a handful of frames to settle height

    const measureHeight = () => {
      try {
        const doc = iframeRef.current?.contentDocument;
        if (doc) {
          const bodyHeight = doc.body?.scrollHeight ?? 0;
          const docHeight = doc.documentElement?.scrollHeight ?? 0;
          const measured = Math.max(bodyHeight, docHeight);
          if (measured > 0) {
            setContentHeight((prev) =>
              Math.abs(prev - measured) > 1 ? measured : prev,
            );
          }
        }
      } catch (err) {
        // Cross-origin guard; if we can't read the iframe, just stop polling.
        attempts = maxAttempts;
      }

      attempts += 1;
      if (attempts <= maxAttempts) {
        rafIdRef.current = requestAnimationFrame(measureHeight);
      }
    };

    measureHeight();

    return () => {
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [isReady, widgetUrl]);

  // Loading state
  if (isStoringWidget) {
    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
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

  // No widget URL yet
  if (!widgetUrl) {
    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
        Preparing widget URL...
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

  // Render iframe
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
      <iframe
        ref={iframeRef}
        src={widgetUrl}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        title={`OpenAI App Widget: ${toolName || "tool"}`}
        allow="web-share"
        className="w-full border border-border/40 rounded-md bg-background"
        style={{
          height: iframeHeight,
          maxHeight: displayMode === "fullscreen" ? "90vh" : undefined,
        }}
        onLoad={() => {
          setIsReady(true);
          setLoadError(null);
        }}
        onError={() => {
          console.error("[OpenAI App] Iframe failed to load");
          setLoadError("Iframe failed to load");
        }}
      />
      {outputTemplate && (
        <div className="text-[11px] text-muted-foreground/70">
          Template: <code>{outputTemplate}</code>
        </div>
      )}

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-6xl h-[70vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{modalTitle}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 w-full h-full min-h-0">
            <iframe
              ref={modalIframeRef}
              src={`${widgetUrl}?view_mode=modal&view_params=${encodeURIComponent(
                JSON.stringify(modalParams),
              )}`}
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
