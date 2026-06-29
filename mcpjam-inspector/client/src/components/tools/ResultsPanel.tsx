import { useEffect, useState } from "react";
import type { CallToolResult } from "@modelcontextprotocol/client";
import {
  Check,
  CheckCircle,
  Clock3,
  Copy,
  ExternalLink,
  Info,
  Loader2,
} from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import type { NormalizedError } from "@mcpjam/sdk/browser";
import { detectUIType, UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import { copyToClipboard } from "@/lib/clipboard";
import { JsonEditor } from "@/components/ui/json-editor";
import { ErrorCard } from "@/components/ui/error-card";
import { extractDisplayFromToolResult } from "@/components/chat-v2/shared/tool-result-text";
import { navigateApp, routePaths } from "@/lib/app-navigation";
import { useActiveHostCapsResolver } from "@/contexts/active-host-client-capabilities-context";
import { useChatboxHostStyle } from "@/contexts/chatbox-client-style-context";
import { hostSupportsWidgetRendering } from "@/lib/host-capabilities";
import { useMcpToolResultImagePreviews } from "@/components/chat-v2/shared/mcp-tool-result-image-preview";
import { McpToolResultImagePreviewGrid } from "@/components/chat-v2/shared/mcp-tool-result-image-preview-grid";
import {
  getMcpToolResultImageRenderPlacement,
  type McpToolResultImageRenderingPolicy,
} from "@/lib/client-config-v2";

interface ResultsPanelProps {
  error: string;
  /**
   * Rich describe-error block accompanying `error` when the source
   * surfaced one (server-side `jsonError` in /api/mcp/tools/execute
   * always populates it now). Falls back to `describeError(error)`
   * inside the ErrorCard when absent.
   */
  normalizedError?: NormalizedError | null;
  result: CallToolResult | null;
  structuredContentValid: boolean | undefined;
  toolMeta?: Record<string, any>;
  responseDurationMs?: number | null;
  /**
   * Name of the server this panel is showing results for. Passed into
   * the host caps resolver so per-server `clientCapabilities` overrides
   * are honored — keeps the "Use the Chat" affordance gated on
   * the same effective capabilities as `initialize`.
   */
  serverName?: string;
  mcpToolResultImageRendering?: McpToolResultImageRenderingPolicy;
}

type ResultViewMode = "images" | "raw";

export function ResultsPanel({
  error,
  normalizedError,
  result,
  structuredContentValid,
  toolMeta,
  responseDurationMs,
  serverName,
  mcpToolResultImageRendering,
}: ResultsPanelProps) {
  const [imageMode, setImageMode] = useState<ResultViewMode>("images");
  const rawResult = result as unknown as Record<string, unknown> | null;
  const extractedDisplay = rawResult
    ? extractDisplayFromToolResult(rawResult)
    : null;
  const displayValue =
    extractedDisplay?.kind === "json" ? extractedDisplay.value : rawResult;
  const uiType = detectUIType(toolMeta, rawResult);
  const hasOpenAIComponent = uiType === UIType.OPENAI_SDK;
  const hasMCPAppsComponent = uiType === UIType.MCP_APPS;
  // Same gate as the chat thread (PartSwitch/WidgetReplay): suppress the
  // "Use the Chat" affordance when the active host (resolved
  // against this server's per-server cap overrides) doesn't advertise
  // the MCP UI extension. Codex etc. won't render the widget in the chat
  // surface either, so pointing the user there is misleading.
  //
  // `serverName` is the key into `appState.servers` and matches the
  // serverId the resolver looks up. The tools tab is single-server per
  // panel, so one lookup per render is all we need.
  const resolveHostCaps = useActiveHostCapsResolver();
  const hostStyle = useChatboxHostStyle();
  const hostSupportsWidgets = hostSupportsWidgetRendering(
    resolveHostCaps(serverName),
    { hostStyle }
  );
  const hasUIComponent =
    hostSupportsWidgets && (hasOpenAIComponent || hasMCPAppsComponent);
  const canRenderImages =
    getMcpToolResultImageRenderPlacement(mcpToolResultImageRendering) !==
    "none";
  const imageState = useMcpToolResultImagePreviews(
    canRenderImages ? result : undefined,
    {
      serverId: serverName,
      renderingPolicy: mcpToolResultImageRendering,
    }
  );
  const formattedResponseTime =
    responseDurationMs == null
      ? null
      : responseDurationMs < 1000
      ? `${Math.round(responseDurationMs)} ms`
      : `${(responseDurationMs / 1000).toFixed(2)} s`;

  const [copied, setCopied] = useState(false);

  const handleCopyAll = async () => {
    let textToCopy: string;
    try {
      textToCopy = JSON.stringify(displayValue, null, 2) ?? "null";
    } catch {
      textToCopy = String(displayValue ?? "");
    }
    const success = await copyToClipboard(textToCopy);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  useEffect(() => {
    setImageMode("images");
  }, [result]);

  return (
    <div className="h-full flex flex-col bg-background break-all">
      {/* Header - fixed height */}
      <div className="flex-shrink-0 flex items-center justify-between p-4 border-b border-border">
        <div className="flex items-center gap-4">
          <h2 className="text-xs font-semibold text-foreground">Response</h2>
          {structuredContentValid && (
            <Badge
              variant="default"
              className="bg-green-600 hover:bg-green-700"
            >
              <CheckCircle className="h-3 w-3 mr-1.5" />
              Structured content matches output schema
            </Badge>
          )}
          {formattedResponseTime && (
            <span className="inline-flex items-center text-xs font-medium text-muted-foreground">
              <Clock3 className="h-3 w-3 mr-1" />
              {formattedResponseTime}
            </span>
          )}
        </div>
        {!error && rawResult && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs px-2 flex-shrink-0"
            onClick={handleCopyAll}
          >
            {copied ? (
              <Check className="h-3 w-3 mr-1 text-success" />
            ) : (
              <Copy className="h-3 w-3 mr-1" />
            )}
            {copied ? "Copied!" : "Copy all"}
          </Button>
        )}
      </div>

      {/* Content - fills remaining space */}
      {error ? (
        <div className="flex-1 p-4">
          <ErrorCard error={normalizedError ?? error} defaultOpen />
        </div>
      ) : rawResult ? (
        <div className="flex-1 min-h-0 p-4 flex flex-col gap-4">
          {hasUIComponent && (
            <div className="flex-shrink-0 p-2 bg-muted/50 border border-border rounded flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Info className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                <span className="text-muted-foreground text-xs">
                  This tool renders UI{" "}
                  {hasMCPAppsComponent
                    ? "with MCP Apps extension"
                    : "with OpenAI Apps SDK"}
                  . Use the <strong>Chat</strong>.
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-xs px-2"
                onClick={() => {
                  navigateApp(routePaths.playground);
                }}
              >
                <ExternalLink className="h-3 w-3 mr-1" />
                Chat
              </Button>
            </div>
          )}
          {imageState.hasCandidate &&
          (imageState.status === "idle" || imageState.status === "loading") ? (
            <div className="flex-1 min-h-0 rounded border border-border bg-muted/20 flex items-center justify-center">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Resolving images...
              </div>
            </div>
          ) : imageState.status === "ready" &&
            imageState.previews.length > 0 ? (
            <>
              <div className="flex flex-shrink-0 items-center justify-end">
                <ToggleGroup
                  type="single"
                  value={imageMode}
                  onValueChange={(value) => {
                    if (value) setImageMode(value as ResultViewMode);
                  }}
                  className="gap-0.5"
                >
                  <ToggleGroupItem
                    value="images"
                    aria-label="Images"
                    className="h-7 px-2 text-xs"
                  >
                    Images
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="raw"
                    aria-label="Raw"
                    className="h-7 px-2 text-xs"
                  >
                    Raw
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
              {imageMode === "images" ? (
                <div className="flex-1 min-h-0 overflow-auto rounded border border-border bg-muted/20 p-3">
                  <McpToolResultImagePreviewGrid
                    previews={imageState.previews}
                    className="sm:grid-cols-[repeat(auto-fit,minmax(220px,1fr))]"
                  />
                </div>
              ) : (
                <div className="flex-1 min-h-0 overflow-hidden">
                  <JsonEditor
                    value={rawResult}
                    readOnly
                    showToolbar={false}
                    height="100%"
                  />
                </div>
              )}
            </>
          ) : (
            <div className="flex-1 min-h-0 overflow-hidden">
              <JsonEditor
                value={displayValue}
                readOnly
                showToolbar={false}
                height="100%"
              />
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-muted-foreground font-medium">
            Execute a tool to see results here
          </p>
        </div>
      )}
    </div>
  );
}
