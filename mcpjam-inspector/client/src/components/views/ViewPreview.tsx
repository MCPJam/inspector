import { useState, useEffect, useCallback, useMemo } from "react";
import { Loader2, AlertCircle } from "lucide-react";
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
  /** Override toolInput from parent for live editing */
  toolInputOverride?: unknown;
  /** Override toolOutput from parent for live editing */
  toolOutputOverride?: unknown;
  /** Override loading state from parent for live editing */
  isLoadingOverride?: boolean;
  /** Override toolOutput error from parent for live editing */
  toolOutputErrorOverride?: string | null;
}

export function ViewPreview({
  view,
  displayMode = "inline",
  onDisplayModeChange,
  serverName,
  serverConnectionStatus,
  toolInputOverride,
  toolOutputOverride,
  isLoadingOverride,
  toolOutputErrorOverride,
}: ViewPreviewProps) {
  const [outputData, setOutputData] = useState<unknown | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Determine if server is offline
  const isServerOffline = serverConnectionStatus !== "connected";

  // Use override values if provided, otherwise use loaded/view data
  const effectiveToolInput =
    toolInputOverride !== undefined ? toolInputOverride : view.toolInput;
  const effectiveToolOutput =
    toolOutputOverride !== undefined ? toolOutputOverride : outputData;
  const effectiveIsLoading =
    isLoadingOverride !== undefined ? isLoadingOverride : isLoading;
  const effectiveError =
    toolOutputErrorOverride !== undefined ? toolOutputErrorOverride : error;

  // Load output blob when view changes (only if no override provided)
  useEffect(() => {
    // Skip loading if override is provided
    if (toolOutputOverride !== undefined) {
      setIsLoading(false);
      setError(null);
      return;
    }

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
  }, [view.toolOutputUrl, view._id, toolOutputOverride]);

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
    [view._id],
  );

  // In view mode, we use the server name (the renderer expects the server name, not the Convex ID)
  // This will be validated before rendering below

  if (effectiveIsLoading) {
    return (
      <div className="flex items-center justify-center p-8 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin mr-2" />
        Loading preview...
      </div>
    );
  }

  if (!effectiveToolOutput) {
    return (
      <div className="flex items-center justify-center p-8 text-destructive">
        <AlertCircle className="h-5 w-5 mr-2" />
        {effectiveError || "No output data available"}
      </div>
    );
  }

  if (!serverName) {
    return (
      <div className="flex items-center justify-center p-8 text-destructive">
        <AlertCircle className="h-5 w-5 mr-2" />
        Server not found. The server that created this view may have been
        deleted.
      </div>
    );
  }

  // Render based on protocol
  if (view.protocol === "mcp-apps") {
    const mcpViewData = view as McpAppView;

    return (
      <div className="relative">
        <MCPAppsRenderer
          key={previewToolCallId}
          serverId={serverName}
          toolCallId={previewToolCallId}
          toolName={view.toolName}
          toolState={view.toolState}
          toolInput={effectiveToolInput as Record<string, unknown> | undefined}
          toolOutput={effectiveToolOutput}
          toolErrorText={view.toolErrorText}
          resourceUri={mcpViewData.resourceUri}
          toolMetadata={
            view.toolMetadata as Record<string, unknown> | undefined
          }
          toolsMetadata={
            mcpViewData.toolsMetadata as
              | Record<string, Record<string, unknown>>
              | undefined
          }
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
    // Get outputTemplate from view or from toolMetadata (fallback for legacy views)
    const existingMetadata = view.toolMetadata as
      | Record<string, unknown>
      | undefined;
    const effectiveOutputTemplate =
      openaiView.outputTemplate ||
      (existingMetadata?.["openai/outputTemplate"] as string | undefined) ||
      "";
    // Merge outputTemplate into toolMetadata for ChatGPTAppRenderer
    // (it extracts outputTemplate from toolMetadata["openai/outputTemplate"])
    const mergedToolMetadata = {
      ...existingMetadata,
      ...(effectiveOutputTemplate
        ? { "openai/outputTemplate": effectiveOutputTemplate }
        : {}),
    };
    return (
      <ChatGPTAppRenderer
        key={previewToolCallId}
        serverId={serverName}
        toolCallId={previewToolCallId}
        toolName={view.toolName}
        toolState={view.toolState}
        toolInput={
          effectiveToolInput as Record<string, unknown> | null | undefined
        }
        toolOutput={effectiveToolOutput}
        toolMetadata={mergedToolMetadata}
        onSendFollowUp={handleSendFollowUp}
        onCallTool={handleCallTool}
        onWidgetStateChange={handleWidgetStateChange}
        serverInfo={openaiView.serverInfo}
        displayMode={displayMode}
        onDisplayModeChange={onDisplayModeChange}
        pipWidgetId={null}
        fullscreenWidgetId={null}
        isOffline={isServerOffline}
        cachedWidgetHtmlUrl={openaiView.widgetHtmlUrl ?? undefined}
      />
    );
  }

  return (
    <div className="flex items-center justify-center p-8 text-muted-foreground">
      Unknown protocol: {(view as AnyView).protocol}
    </div>
  );
}
