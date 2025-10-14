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
  toolMeta?: Record<string, any>; // Tool metadata from tool definition (includes openai/outputTemplate)
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
  serverId,
  toolMeta,
}: OpenAIComponentRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [widgetUrl, setWidgetUrl] = useState<string | null>(null);

  // Storage key for widget state
  const widgetStateKey = `openai-widget-state:${toolCall.name}:${toolCall.id}`;

  // Store widget data server-side
  useEffect(() => {
    if (componentUrl.startsWith("ui://") && serverId) {
      // Extract structured content from different result formats
      // 1. Backend flow: toolResult.result.structuredContent
      // 2. Local AI SDK flow: toolResult.result[0].output.value.structuredContent
      let structuredContent = null;

      if (toolResult?.result) {
        const result = toolResult.result;

        // Check if it's directly available
        if (result.structuredContent) {
          structuredContent = result.structuredContent;
        }
        // Check if wrapped in array (AI SDK format)
        else if (Array.isArray(result) && result[0]) {
          const firstResult = result[0];
          // AI SDK format: {type, output: {value: {structuredContent}}}
          if (firstResult.output?.value?.structuredContent) {
            structuredContent = firstResult.output.value.structuredContent;
          } else if (firstResult.structuredContent) {
            structuredContent = firstResult.structuredContent;
          } else if (firstResult.output?.value) {
            // Use the entire value if no structuredContent field
            structuredContent = firstResult.output.value;
          }
        }

        // Fallback to entire result if nothing else found
        if (!structuredContent) {
          structuredContent = result;
        }
      }

      // Store widget data, then set URL once storage completes
      const storeAndSetUrl = async () => {
        try {
          await fetch("/api/mcp/resources/widget/store", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              serverId,
              uri: componentUrl,
              toolInput: toolCall.parameters,
              toolOutput: structuredContent,
              toolId: toolCall.id,
            }),
          });

          // Only set URL after data is stored
          const url = `/api/mcp/resources/widget/${toolCall.id}`;
          setWidgetUrl(url);
        } catch (error) {
          console.error("Error storing widget data:", error);
          setError(
            error instanceof Error
              ? error.message
              : "Failed to prepare widget",
          );
        }
      };

      storeAndSetUrl();
    } else if (
      componentUrl.startsWith("http://") ||
      componentUrl.startsWith("https://")
    ) {
      // External URLs use src directly
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
