import { useState, useEffect, useCallback, useMemo } from "react";
import { Loader2, AlertCircle, WifiOff } from "lucide-react";
import { MCPAppsRenderer } from "@/components/chat-v2/thread/mcp-apps-renderer";
import { ChatGPTAppRenderer } from "@/components/chat-v2/thread/chatgpt-app-renderer";
import { type DisplayMode } from "@/stores/ui-playground-store";
import {
  type AnyView,
  type McpAppView,
  type OpenaiAppView,
} from "@/hooks/useViews";
import { type ConnectionStatus } from "@/state/app-types";

interface ViewPreviewProps {
  view: AnyView;
  displayMode?: DisplayMode;
  onDisplayModeChange?: (mode: DisplayMode) => void;
  serverName?: string;
  /** Server connection status for determining online/offline state */
  serverConnectionStatus?: ConnectionStatus;
}

export function ViewPreview({
  view,
  displayMode = "inline",
  onDisplayModeChange,
  serverName,
  serverConnectionStatus,
}: ViewPreviewProps) {
  const [outputData, setOutputData] = useState<unknown | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Determine if server is offline
  const isServerOffline = serverConnectionStatus !== "connected";

  // Check if we have cached widget HTML for offline rendering (MCP Apps only)
  const mcpView = view.protocol === "mcp-apps" ? (view as McpAppView) : null;
  const hasCachedHtml = !!(mcpView?.widgetHtmlUrl);

  // Load output blob when view changes
  useEffect(() => {
    async function loadOutput() {
      if (!view.toolOutputUrl) {
        setOutputData(null);
        setIsLoading(false);
        setError("No output URL available");
        return;
      }

      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch(view.toolOutputUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch output: ${response.status}`);
        }
        const data = await response.json();
        setOutputData(data);
      } catch (err) {
        console.error("Failed to load output:", err);
        setError(err instanceof Error ? err.message : "Failed to load output");
        setOutputData(null);
      } finally {
        setIsLoading(false);
      }
    }

    loadOutput();
  }, [view.toolOutputUrl, view._id]);

  // No-op callbacks for view mode (read-only)
  const handleSendFollowUp = useCallback(() => {
    // No-op in view mode
  }, []);

  const handleCallTool = useCallback(async () => {
    // No-op in view mode - return empty result
    return {};
  }, []);

  const handleWidgetStateChange = useCallback(() => {
    // No-op in view mode
  }, []);

  const handleModelContextUpdate = useCallback(() => {
    // No-op in view mode
  }, []);

  // Generate a stable tool call ID for the preview
  const previewToolCallId = useMemo(
    () => `view-preview-${view._id}`,
    [view._id]
  );

  // In view mode, we use the server name (the renderer expects the server name, not the Convex ID)
  // This will be validated before rendering below

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin mr-2" />
        Loading preview...
      </div>
    );
  }

  if (error || !outputData) {
    return (
      <div className="flex items-center justify-center p-8 text-destructive">
        <AlertCircle className="h-5 w-5 mr-2" />
        {error || "No output data available"}
      </div>
    );
  }

  if (!serverName) {
    return (
      <div className="flex items-center justify-center p-8 text-destructive">
        <AlertCircle className="h-5 w-5 mr-2" />
        Server not found. The server that created this view may have been deleted.
      </div>
    );
  }

  // Render based on protocol
  if (view.protocol === "mcp-apps") {
    const mcpViewData = view as McpAppView;

    // Show offline warning if server is offline and we have cached content
    const showOfflineIndicator = isServerOffline && hasCachedHtml;

    return (
      <div className="relative">
        {showOfflineIndicator && (
          <div className="flex items-center gap-2 px-3 py-2 mb-2 text-xs bg-amber-500/10 border border-amber-500/30 rounded-md text-amber-600 dark:text-amber-400">
            <WifiOff className="h-4 w-4 flex-shrink-0" />
            <span>
              Server is offline. Showing cached content from when view was saved.
            </span>
          </div>
        )}
        <MCPAppsRenderer
          serverId={serverName}
          toolCallId={previewToolCallId}
          toolName={view.toolName}
          toolState={view.toolState}
          toolInput={view.toolInput as Record<string, unknown> | undefined}
          toolOutput={outputData}
          toolErrorText={view.toolErrorText}
          resourceUri={mcpViewData.resourceUri}
          toolMetadata={view.toolMetadata as Record<string, unknown> | undefined}
          toolsMetadata={mcpViewData.toolsMetadata as Record<string, Record<string, unknown>> | undefined}
          onSendFollowUp={handleSendFollowUp}
          onCallTool={handleCallTool}
          onWidgetStateChange={handleWidgetStateChange}
          onModelContextUpdate={handleModelContextUpdate}
          displayMode={displayMode}
          onDisplayModeChange={onDisplayModeChange}
          pipWidgetId={null}
          fullscreenWidgetId={null}
          isOffline={isServerOffline}
          cachedWidgetHtmlUrl={mcpViewData.widgetHtmlUrl ?? undefined}
        />
      </div>
    );
  }

  if (view.protocol === "openai-apps") {
    const openaiView = view as OpenaiAppView;
    return (
      <ChatGPTAppRenderer
        serverId={serverName}
        toolCallId={previewToolCallId}
        toolName={view.toolName}
        toolState={view.toolState}
        toolInput={view.toolInput as Record<string, unknown> | null | undefined}
        toolOutput={outputData}
        toolMetadata={view.toolMetadata as Record<string, unknown> | undefined}
        onSendFollowUp={handleSendFollowUp}
        onCallTool={handleCallTool}
        onWidgetStateChange={handleWidgetStateChange}
        serverInfo={openaiView.serverInfo}
        displayMode={displayMode}
        onDisplayModeChange={onDisplayModeChange}
        pipWidgetId={null}
        fullscreenWidgetId={null}
      />
    );
  }

  return (
    <div className="flex items-center justify-center p-8 text-muted-foreground">
      Unknown protocol: {(view as AnyView).protocol}
    </div>
  );
}
