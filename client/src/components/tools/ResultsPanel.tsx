import { useMemo } from "react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolExecutionResponse } from "@/lib/mcp-tools-api";
import { UIResourceRenderer } from "@mcp-ui/client";
import { CheckCircle, XCircle } from "lucide-react";
import { OpenAIAppRenderer } from "../chat-v2/openai-app-renderer";
import { MCPAppsRenderer } from "../chat-v2/mcp-apps-renderer";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";

type UnstructuredStatus =
  | "not_applicable"
  | "valid"
  | "invalid_json"
  | "schema_mismatch";

type UIResource = {
  uri: string;
  [key: string]: unknown;
};

function resolveUIResource(
  rawResult: CallToolResult | null,
): UIResource | null {
  if (!rawResult) return null;
  const base = rawResult as unknown as Record<string, unknown>;
  const direct = base?.resource;
  if (
    direct &&
    typeof direct === "object" &&
    typeof (direct as Record<string, unknown>).uri === "string" &&
    ((direct as Record<string, unknown>).uri as string).startsWith("ui://")
  ) {
    return direct as UIResource;
  }

  const content = base?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (
        item &&
        item.type === "resource" &&
        item.resource &&
        typeof item.resource.uri === "string" &&
        item.resource.uri.startsWith("ui://")
      ) {
        return item.resource as UIResource;
      }
    }
  }

  return null;
}

interface ResultsPanelProps {
  error: string;
  showStructured: boolean;
  onToggleStructured: (show: boolean) => void;
  structuredResult: Record<string, unknown> | null;
  result: CallToolResult | null;
  validationErrors: any[] | null | undefined;
  unstructuredValidationResult: UnstructuredStatus;
  onExecuteFromUI: (
    toolName: string,
    params?: Record<string, unknown>,
  ) => Promise<ToolExecutionResponse>;
  onHandleIntent: (
    intent: string,
    params?: Record<string, unknown>,
  ) => Promise<void>;
  onSendFollowup?: (message: string) => void;
  serverId?: string;
  toolCallId?: string;
  toolName?: string;
  toolParameters?: Record<string, unknown>;
  toolMeta?: Record<string, any>; // Tool metadata from definition (_meta field)
}

export function ResultsPanel({
  error,
  showStructured,
  onToggleStructured,
  structuredResult,
  result,
  validationErrors,
  unstructuredValidationResult,
  onExecuteFromUI,
  onHandleIntent,
  onSendFollowup,
  serverId,
  toolCallId,
  toolName,
  toolParameters,
  toolMeta,
}: ResultsPanelProps) {
  // Generate a stable fallback toolCallId to avoid re-renders causing ID mismatches
  const resolvedToolCallId = useMemo(
    () => toolCallId ?? `tools-tab-${toolName || "unknown"}-${Date.now()}`,
    [toolCallId, toolName],
  );

  const rawResult = result as unknown as Record<string, unknown> | null;
  // Check for OpenAI component using tool metadata from definition
  const openaiOutputTemplate = toolMeta?.["openai/outputTemplate"];
  const hasOpenAIComponent =
    openaiOutputTemplate && typeof openaiOutputTemplate === "string";
  // Check for MCP Apps (SEP-1865) using ui/resourceUri in tool metadata
  const mcpAppsResourceUri = toolMeta?.["ui/resourceUri"];
  const hasMCPAppsComponent =
    mcpAppsResourceUri && typeof mcpAppsResourceUri === "string";
  const uiResource = resolveUIResource(result);

  return (
    <div className="h-full flex flex-col border-t border-border bg-background break-all">
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div className="flex items-center gap-4">
          <h2 className="text-xs font-semibold text-foreground">Response</h2>
          {showStructured &&
            validationErrors !== undefined &&
            (validationErrors === null ? (
              <Badge
                variant="default"
                className="bg-green-600 hover:bg-green-700"
              >
                <CheckCircle className="h-3 w-3 mr-1.5" />
                Valid
              </Badge>
            ) : (
              <Badge variant="destructive">
                <XCircle className="h-3 w-3 mr-1.5" />
                Invalid
              </Badge>
            ))}
        </div>
        {rawResult &&
          (structuredResult || hasOpenAIComponent || hasMCPAppsComponent) && (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={!showStructured ? "default" : "outline"}
                onClick={() => onToggleStructured(false)}
              >
                {hasOpenAIComponent || hasMCPAppsComponent
                  ? "Component"
                  : "Raw Output"}
              </Button>
              <Button
                size="sm"
                variant={showStructured ? "default" : "outline"}
                onClick={() => onToggleStructured(true)}
              >
                {hasOpenAIComponent || hasMCPAppsComponent
                  ? "Raw JSON"
                  : "Structured Output"}
              </Button>
            </div>
          )}
      </div>

      <div className="flex-1 overflow-hidden">
        {error ? (
          <div className="p-4">
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded text-destructive text-xs font-medium">
              {error}
            </div>
          </div>
        ) : showStructured && validationErrors ? (
          <div className="p-4">
            <h3 className="text-sm font-semibold text-destructive mb-2">
              Validation Errors
            </h3>
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
              <JsonView
                src={validationErrors}
                theme="atom"
                dark={true}
                enableClipboard={true}
                displaySize={false}
                collapseStringsAfterLength={100}
                style={{
                  fontSize: "12px",
                  fontFamily:
                    "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                  backgroundColor: "hsl(var(--background))",
                  padding: "16px",
                  borderRadius: "8px",
                  border: "1px solid hsl(var(--border))",
                }}
              />
              {Array.isArray(validationErrors) &&
                validationErrors.length > 0 && (
                  <span className="text-sm font-semibold text-destructive mb-2">{`${validationErrors[0].instancePath?.slice(1) ?? ""} ${validationErrors[0].message ?? ""}`}</span>
                )}
            </div>
          </div>
        ) : showStructured && rawResult && hasOpenAIComponent ? (
          <ScrollArea className="h-full">
            <div className="p-4">
              <JsonView
                src={rawResult}
                dark={true}
                theme="atom"
                enableClipboard={true}
                displaySize={false}
                collapseStringsAfterLength={100}
                style={{
                  fontSize: "12px",
                  fontFamily:
                    "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                  backgroundColor: "hsl(var(--background))",
                  padding: "16px",
                  borderRadius: "8px",
                  border: "1px solid hsl(var(--border))",
                }}
              />
            </div>
          </ScrollArea>
        ) : showStructured &&
          structuredResult &&
          (validationErrors === null || validationErrors === undefined) ? (
          <ScrollArea className="h-full">
            <div className="p-4">
              <JsonView
                src={structuredResult}
                dark={true}
                theme="atom"
                enableClipboard={true}
                displaySize={false}
                collapseStringsAfterLength={100}
                style={{
                  fontSize: "12px",
                  fontFamily:
                    "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                  backgroundColor: "hsl(var(--background))",
                  padding: "16px",
                  borderRadius: "8px",
                  border: "1px solid hsl(var(--border))",
                }}
              />
            </div>
          </ScrollArea>
        ) : rawResult ? (
          (() => {
            // MCP Apps (SEP-1865) rendering - check first before OpenAI
            if (!showStructured && hasMCPAppsComponent && mcpAppsResourceUri) {
              return (
                <MCPAppsRenderer
                  serverId={serverId || "unknown-server"}
                  toolCallId={resolvedToolCallId}
                  toolName={toolName || "unknown-tool"}
                  toolState="output-available"
                  toolInput={toolParameters}
                  toolOutput={rawResult}
                  resourceUri={mcpAppsResourceUri}
                  toolMetadata={toolMeta}
                  onSendFollowUp={onSendFollowup}
                  onCallTool={async (invocationToolName, params) => {
                    const toolResponse = await onExecuteFromUI(
                      invocationToolName,
                      params,
                    );

                    if ("error" in toolResponse) {
                      throw new Error(toolResponse.error);
                    }

                    if (toolResponse.status === "completed") {
                      const result = toolResponse.result as any;
                      return {
                        content: result?.content || [],
                        structuredContent: result?.structuredContent || result,
                      };
                    }

                    throw new Error(
                      "Elicitation not supported in this context",
                    );
                  }}
                />
              );
            }

            if (!showStructured && hasOpenAIComponent && openaiOutputTemplate) {
              return (
                <OpenAIAppRenderer
                  serverId={serverId || "unknown-server"}
                  toolCallId={toolCallId}
                  toolName={toolName}
                  toolState="output-available"
                  toolInput={toolParameters || null}
                  toolOutput={rawResult}
                  toolMetadata={toolMeta}
                  onSendFollowUp={onSendFollowup}
                  onCallTool={async (invocationToolName, params) => {
                    const toolResponse = await onExecuteFromUI(
                      invocationToolName,
                      params,
                    );

                    // Return the response in ChatGPT's expected format
                    if ("error" in toolResponse) {
                      return {
                        isError: true,
                        error: toolResponse.error,
                      };
                    }

                    if (toolResponse.status === "completed") {
                      // Extract structured content from the result
                      const result = toolResponse.result as any;
                      const structuredContent =
                        result?.structuredContent || result;

                      return {
                        _meta: null,
                        content: result?.content || [],
                        structuredContent: structuredContent,
                        isError: false,
                        result: JSON.stringify(structuredContent),
                        meta: {},
                      };
                    }
                    // Elicitation not supported in widgets yet
                    return {
                      isError: true,
                      error: "Elicitation not supported in this context",
                    };
                  }}
                />
              );
            }

            if (!showStructured && uiResource) {
              return (
                <UIResourceRenderer
                  resource={uiResource}
                  htmlProps={{
                    autoResizeIframe: true,
                    style: {
                      width: "100%",
                      minHeight: "500px",
                      height: "auto",
                      overflow: "visible",
                    },
                  }}
                  onUIAction={async (evt) => {
                    if (evt.type === "tool" && evt.payload?.toolName) {
                      await onExecuteFromUI(
                        evt.payload.toolName,
                        evt.payload.params || {},
                      );
                    } else if (evt.type === "intent" && evt.payload?.intent) {
                      await onHandleIntent(
                        evt.payload.intent,
                        evt.payload.params || {},
                      );
                    } else if (evt.type === "link" && evt.payload?.url) {
                      window.open(
                        evt.payload.url,
                        "_blank",
                        "noopener,noreferrer",
                      );
                    }
                    return { status: "handled" } as any;
                  }}
                />
              );
            }

            return (
              <ScrollArea className="h-full">
                <div className="p-4">
                  {unstructuredValidationResult === "valid" && (
                    <Badge
                      variant="default"
                      className="bg-green-600 hover:bg-green-700 mb-4"
                    >
                      <CheckCircle className="h-3 w-3 mr-1.5" />
                      Success: Content matches the output schema.
                    </Badge>
                  )}
                  {unstructuredValidationResult === "schema_mismatch" && (
                    <Badge variant="destructive" className="mb-4">
                      <XCircle className="h-3 w-3 mr-1.5" />
                      Error: Content does not match the output schema.
                    </Badge>
                  )}
                  {unstructuredValidationResult === "invalid_json" && (
                    <Badge
                      variant="destructive"
                      className="bg-amber-600 hover:bg-amber-700 mb-4"
                    >
                      <XCircle className="h-3 w-3 mr-1.5" />
                      Warning: Output schema provided by the tool is invalid.
                    </Badge>
                  )}
                  <JsonView
                    src={rawResult}
                    dark={true}
                    theme="atom"
                    enableClipboard={true}
                    displaySize={false}
                    collapseStringsAfterLength={100}
                    style={{
                      fontSize: "12px",
                      fontFamily:
                        "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                      backgroundColor: "hsl(var(--background))",
                      padding: "16px",
                      borderRadius: "8px",
                      border: "1px solid hsl(var(--border))",
                    }}
                  />
                </div>
              </ScrollArea>
            );
          })()
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-xs text-muted-foreground font-medium">
              Execute a tool to see results here
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
