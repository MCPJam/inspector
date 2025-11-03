import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

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
}: OpenAIAppRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("inline");
  const [maxHeight, setMaxHeight] = useState<number>(600);
  const [contentHeight, setContentHeight] = useState<number>(600);
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [widgetUrl, setWidgetUrl] = useState<string | null>(null);
  const [isStoringWidget, setIsStoringWidget] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);

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
            toolResponseMetadata: null, // Can be extended later
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
  }, [toolState, resolvedToolCallId, widgetUrl, outputTemplate, toolName]);

  const appliedHeight = useMemo(
    () => Math.min(Math.max(contentHeight, 320), maxHeight),
    [contentHeight, maxHeight],
  );

  const iframeHeight = useMemo(() => {
    if (displayMode === "fullscreen") return "80vh";
    if (displayMode === "pip") return "400px";
    return `${appliedHeight}px`;
  }, [appliedHeight, displayMode]);

  // Handle messages from iframe
  const handleMessage = useCallback(
    async (event: MessageEvent) => {
      if (
        !iframeRef.current ||
        event.source !== iframeRef.current.contentWindow
      )
        return;

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
          break;
        }

        case "openai:callTool": {
          if (!onCallTool) {
            console.warn(
              "[OpenAI App] callTool received but handler not available",
            );
            iframeRef.current?.contentWindow?.postMessage(
              {
                type: "openai:callTool:response",
                requestId: event.data.requestId,
                error: "callTool is not supported in this context",
              },
              "*",
            );
            break;
          }

          try {
            const result = await onCallTool(
              event.data.toolName,
              event.data.params || {},
            );
            iframeRef.current?.contentWindow?.postMessage(
              {
                type: "openai:callTool:response",
                requestId: event.data.requestId,
                result,
              },
              "*",
            );
          } catch (err) {
            iframeRef.current?.contentWindow?.postMessage(
              {
                type: "openai:callTool:response",
                requestId: event.data.requestId,
                error: err instanceof Error ? err.message : "Unknown error",
              },
              "*",
            );
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
            setDisplayMode(event.data.mode);
          }
          if (typeof event.data.maxHeight === "number") {
            setMaxHeight(event.data.maxHeight);
          }
          break;
        }

        case "openai:openExternal": {
          if (event.data.href && typeof event.data.href === "string") {
            window.open(event.data.href, "_blank", "noopener,noreferrer");
          }
          break;
        }
      }
    },
    [onCallTool, onSendFollowUp],
  );

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [handleMessage]);

  // Send theme updates to iframe when theme changes
  useEffect(() => {
    if (!isReady || !iframeRef.current?.contentWindow) return;

    console.log("[OpenAI App] Sending theme update to iframe:", themeMode);
    iframeRef.current.contentWindow.postMessage(
      {
        type: "openai:set_globals",
        globals: {
          theme: themeMode,
        },
      },
      "*",
    );
  }, [themeMode, isReady]);

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

  // Render iframe
  return (
    <div className="mt-3 space-y-2">
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
          minHeight: "320px",
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
    </div>
  );
}
