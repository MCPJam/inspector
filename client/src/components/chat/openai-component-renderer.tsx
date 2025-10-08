import { useEffect, useRef, useState } from "react";
import { ToolCall, ToolResult } from "@/lib/chat-types";

interface OpenAIComponentRendererProps {
  componentUrl: string;
  toolCall: ToolCall;
  toolResult?: ToolResult;
  onCallTool?: (toolName: string, params: Record<string, any>) => Promise<any>;
  onSendFollowup?: (message: string) => void;
  className?: string;
  uiResourceBlob?: string; // HTML blob for ui:// URIs
  serverId?: string; // Server ID for fetching ui:// resources
}

interface WindowOpenAIAPI {
  toolInput: Record<string, any>;
  toolOutput: any;
  setWidgetState: (state: any) => Promise<void>;
  callTool: (toolName: string, params?: Record<string, any>) => Promise<any>;
  sendFollowupTurn: (message: string) => Promise<void>;
}

/**
 * OpenAIComponentRenderer renders OpenAI Apps SDK components
 * Provides window.openai API bridge for component interaction
 */
export function OpenAIComponentRenderer({
  componentUrl,
  toolCall,
  toolResult,
  onCallTool,
  onSendFollowup,
  className,
  uiResourceBlob,
  serverId,
}: OpenAIComponentRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [widgetUrl, setWidgetUrl] = useState<string | null>(null);

  // Storage key for widget state
  const widgetStateKey = `openai-widget-state:${toolCall.name}:${toolCall.id}`;

  // Build HTTP URL for widget serving
  useEffect(() => {
    if (componentUrl.startsWith("ui://") && serverId) {
      // Use HTTP endpoint to serve widget with injected API
      const encodedUri = encodeURIComponent(componentUrl);
      const toolInput = encodeURIComponent(JSON.stringify(toolCall.parameters));
      const toolOutput = encodeURIComponent(
        JSON.stringify(toolResult?.result || null),
      );
      const url = `/api/mcp/resources/openai-widget/${serverId}/${encodedUri}?toolInput=${toolInput}&toolOutput=${toolOutput}&toolId=${toolCall.id}`;

      setWidgetUrl(url);
    } else if (
      componentUrl.startsWith("http://") ||
      componentUrl.startsWith("https://")
    ) {
      // Use HTTP(S) URL directly
      setWidgetUrl(componentUrl);
    }
  }, [
    componentUrl,
    serverId,
    toolCall.parameters,
    toolCall.id,
    toolResult?.result,
  ]);

  // Handle postMessage communication with iframe
  useEffect(() => {
    if (!widgetUrl) return;

    const handleMessage = async (event: MessageEvent) => {
      // Only accept messages from our iframe
      if (
        !iframeRef.current ||
        event.source !== iframeRef.current.contentWindow
      ) {
        return;
      }

      switch (event.data.type) {
        case "openai:setWidgetState":
          try {
            localStorage.setItem(
              widgetStateKey,
              JSON.stringify(event.data.state),
            );
          } catch (err) {
            throw err;
          }
          break;

        case "openai:callTool":
          if (onCallTool) {
            try {
              const result = await onCallTool(
                event.data.toolName,
                event.data.params || {},
              );
              iframeRef.current?.contentWindow?.postMessage(
                {
                  type: "openai:callTool:response",
                  requestId: event.data.requestId,
                  result: result,
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
          }
          break;

        case "openai:sendFollowup":
          if (onSendFollowup) {
            onSendFollowup(event.data.message);
          }
          break;
      }
    };

    window.addEventListener("message", handleMessage);

    const handleLoad = () => {
      setIsReady(true);
      setError(null);
    };

    const handleError = (e: ErrorEvent) => {
      setError("Failed to load component");
    };

    iframeRef.current?.addEventListener("load", handleLoad);
    iframeRef.current?.addEventListener("error", handleError as any);

    return () => {
      window.removeEventListener("message", handleMessage);
      iframeRef.current?.removeEventListener("load", handleLoad);
      iframeRef.current?.removeEventListener("error", handleError as any);
    };
  }, [widgetUrl, widgetStateKey, onCallTool, onSendFollowup]);

  return (
    <div className={className}>
      {error && (
        <div className="bg-red-50/30 dark:bg-red-950/20 border border-red-200/50 dark:border-red-800/50 rounded-lg p-4 mb-2">
          <p className="text-sm text-red-600 dark:text-red-400">
            Failed to load component: {error}
          </p>
        </div>
      )}

      {!isReady && widgetUrl && (
        <div className="bg-blue-50/30 dark:bg-blue-950/20 border border-blue-200/50 dark:border-blue-800/50 rounded-lg p-4 mb-2">
          <p className="text-sm text-blue-600 dark:text-blue-400">
            Loading component...
          </p>
        </div>
      )}

      {widgetUrl ? (
        <iframe
          ref={iframeRef}
          src={widgetUrl}
          className="w-full border rounded-md bg-white dark:bg-gray-900"
          style={{
            minHeight: "400px",
            height: "600px",
            maxHeight: "80vh",
            border: "1px solid rgba(128, 128, 128, 0.3)",
          }}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          title={`OpenAI Component: ${toolCall.name}`}
          allow="web-share"
        />
      ) : (
        <div className="bg-yellow-50/30 dark:bg-yellow-950/20 border border-yellow-200/50 dark:border-yellow-800/50 rounded-lg p-4">
          <p className="text-sm text-yellow-600 dark:text-yellow-400">
            Preparing component URL...
          </p>
        </div>
      )}
    </div>
  );
}
