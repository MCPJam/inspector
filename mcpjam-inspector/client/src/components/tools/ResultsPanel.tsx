import type { CallToolResult } from "@modelcontextprotocol/client";
import { CheckCircle, Info, ExternalLink, Clock3 } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { detectUIType, UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import { JsonEditor } from "@/components/ui/json-editor";
import { extractDisplayFromToolResult } from "@/components/chat-v2/shared/tool-result-text";
import { navigateApp } from "@/lib/app-navigation";
import { useActiveHostCapsResolver } from "@/contexts/active-host-client-capabilities-context";
import { hostSupportsWidgetRendering } from "@/lib/host-capabilities";

interface ResultsPanelProps {
  error: string;
  result: CallToolResult | null;
  structuredContentValid: boolean | undefined;
  toolMeta?: Record<string, any>;
  responseDurationMs?: number | null;
  /**
   * Name of the server this panel is showing results for. Passed into
   * the host caps resolver so per-server `clientCapabilities` overrides
   * are honored — keeps the "Use the App Builder" affordance gated on
   * the same effective capabilities as `initialize`.
   */
  serverName?: string;
}

export function ResultsPanel({
  error,
  result,
  structuredContentValid,
  toolMeta,
  responseDurationMs,
  serverName,
}: ResultsPanelProps) {
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
  // "Use the App Builder" affordance when the active host (resolved
  // against this server's per-server cap overrides) doesn't advertise
  // the MCP UI extension. Codex etc. won't render the widget in the chat
  // surface either, so pointing the user there is misleading.
  //
  // `serverName` is the key into `appState.servers` and matches the
  // serverId the resolver looks up. The tools tab is single-server per
  // panel, so one lookup per render is all we need.
  const resolveHostCaps = useActiveHostCapsResolver();
  const hostSupportsWidgets = hostSupportsWidgetRendering(
    resolveHostCaps(serverName)
  );
  const hasUIComponent =
    hostSupportsWidgets && (hasOpenAIComponent || hasMCPAppsComponent);
  const formattedResponseTime =
    responseDurationMs == null
      ? null
      : responseDurationMs < 1000
      ? `${Math.round(responseDurationMs)} ms`
      : `${(responseDurationMs / 1000).toFixed(2)} s`;

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
      </div>

      {/* Content - fills remaining space */}
      {error ? (
        <div className="flex-1 p-4">
          <div className="p-3 bg-destructive/10 border border-destructive/20 rounded text-destructive text-xs font-medium">
            {error}
          </div>
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
                  . Use the <strong>App Builder</strong>.
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-xs px-2"
                onClick={() => {
                  navigateApp("/app-builder");
                }}
              >
                <ExternalLink className="h-3 w-3 mr-1" />
                App Builder
              </Button>
            </div>
          )}
          {/* JSON Editor - fills ALL remaining space */}
          <div className="flex-1 min-h-0 overflow-hidden">
            <JsonEditor
              value={displayValue}
              readOnly
              showToolbar={false}
              height="100%"
            />
          </div>
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
