import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { CheckCircle, XCircle } from "lucide-react";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import { UIResourceRenderer } from "@mcp-ui/client";
import { OpenAIComponentRenderer } from "../chat/openai-component-renderer";
import { extractOpenAIComponent } from "@/lib/openai-apps-sdk-utils";

function getUIResourceFromResult(rawResult: any): any | null {
  if (!rawResult) return null;
  const direct = (rawResult as any)?.resource;
  if (
    direct &&
    typeof direct === "object" &&
    typeof direct.uri === "string" &&
    direct.uri.startsWith("ui://")
  ) {
    return direct;
  }
  const content = (rawResult as any)?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (
        item &&
        item.type === "resource" &&
        item.resource &&
        typeof item.resource.uri === "string" &&
        item.resource.uri.startsWith("ui://")
      ) {
        return item.resource;
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
  result: Record<string, unknown> | null;
  validationErrors: any[] | null | undefined;
  unstructuredValidationResult:
    | "not_applicable"
    | "valid"
    | "invalid_json"
    | "schema_mismatch";
  onExecuteFromUI: (
    toolName: string,
    params?: Record<string, any>,
  ) => Promise<void>;
  onHandleIntent: (
    intent: string,
    params?: Record<string, any>,
  ) => Promise<void>;
  onSendFollowup?: (message: string) => void;
  serverId?: string;
  toolCallId?: string;
  toolName?: string;
  toolParameters?: Record<string, any>;
  toolCallTimestamp?: Date;
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
  toolCallTimestamp,
}: ResultsPanelProps) {
  return (
    <div className="h-full flex flex-col border-t border-border bg-background">
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
        {result &&
          (structuredResult || extractOpenAIComponent(result as any)) && (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={!showStructured ? "default" : "outline"}
                onClick={() => onToggleStructured(false)}
              >
                {extractOpenAIComponent(result as any)
                  ? "Component"
                  : "Raw Output"}
              </Button>
              <Button
                size="sm"
                variant={showStructured ? "default" : "outline"}
                onClick={() => onToggleStructured(true)}
              >
                {extractOpenAIComponent(result as any)
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
          // Validation errors view
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
        ) : showStructured &&
          result &&
          extractOpenAIComponent(result as any) ? (
          // Raw JSON view for OpenAI components - show complete result
          <ScrollArea className="h-full">
            <div className="p-4">
              <JsonView
                src={result}
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
        ) : showStructured && structuredResult && validationErrors === null ? (
          // Structured Output view for regular tools
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
        ) : result && !showStructured ? (
          // Raw Output view - show OpenAI component or full JSON
          (() => {
            const openaiComponent = extractOpenAIComponent(result as any);

            // If there's an OpenAI component, render it
            if (openaiComponent) {
              return (
                <OpenAIComponentRenderer
                  componentUrl={openaiComponent.url}
                  toolCall={{
                    id: toolCallId || "tool-result",
                    name: toolName || "tool",
                    parameters: toolParameters || {},
                    timestamp: toolCallTimestamp || new Date(),
                    status: "completed",
                  }}
                  toolResult={{
                    id: `${toolCallId || "tool-result"}-result`,
                    toolCallId: toolCallId || "tool-result",
                    result: result,
                    timestamp: new Date(),
                  }}
                  onCallTool={async (toolName, params) => {
                    await onExecuteFromUI(toolName, params);
                    return {};
                  }}
                  onSendFollowup={onSendFollowup}
                  uiResourceBlob={openaiComponent.htmlBlob}
                  serverId={serverId}
                />
              );
            }

            // Check for MCP-UI resource
            const uiRes = getUIResourceFromResult(result as any);
            if (uiRes) {
              return (
                <UIResourceRenderer
                  resource={uiRes}
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

            // No UI component - show full raw JSON
            return (
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
                  src={result}
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
                    width: "calc(100vw - var(--sidebar-width) - 16px - 16px)",
                  }}
                />
              </div>
            );
          })()
        ) : (
          // No result yet
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
