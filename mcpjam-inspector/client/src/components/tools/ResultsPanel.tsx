import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CheckCircle, XCircle, Info, ExternalLink } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { detectUIType, UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import { JsonEditor } from "@/components/ui/json-editor";

type UnstructuredStatus =
  | "not_applicable"
  | "valid"
  | "invalid_json"
  | "schema_mismatch";

interface ResultsPanelProps {
  error: string;
  result: CallToolResult | null;
  validationErrors: any[] | null | undefined;
  unstructuredValidationResult: UnstructuredStatus;
  toolMeta?: Record<string, any>; // Tool metadata from definition (_meta field)
}

export function ResultsPanel({
  error,
  result,
  validationErrors,
  unstructuredValidationResult,
  toolMeta,
}: ResultsPanelProps) {
  const rawResult = result as unknown as Record<string, unknown> | null;
  const uiType = detectUIType(toolMeta, rawResult);
  const hasOpenAIComponent = uiType === UIType.OPENAI_SDK;
  const hasMCPAppsComponent = uiType === UIType.MCP_APPS;
  const hasUIComponent = hasOpenAIComponent || hasMCPAppsComponent;

  return (
    <div className="h-full flex flex-col border-t border-border bg-background break-all">
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div className="flex items-center gap-4">
          <h2 className="text-xs font-semibold text-foreground">Response</h2>
          {validationErrors !== undefined &&
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
      </div>

      <div className="flex-1 overflow-hidden">
        {error ? (
          <div className="p-4">
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded text-destructive text-xs font-medium">
              {error}
            </div>
          </div>
        ) : validationErrors ? (
          <div className="p-4">
            <h3 className="text-sm font-semibold text-destructive mb-2">
              Validation Errors
            </h3>
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
              <JsonEditor
                value={validationErrors}
                readOnly
                showToolbar={false}
              />
              {Array.isArray(validationErrors) &&
                validationErrors.length > 0 && (
                  <span className="text-sm font-semibold text-destructive mb-2">{`${validationErrors[0].instancePath?.slice(1) ?? ""} ${validationErrors[0].message ?? ""}`}</span>
                )}
            </div>
          </div>
        ) : rawResult ? (
          <ScrollArea className="h-full">
            <div className="p-4">
              {hasUIComponent && (
                <div className="p-2 mb-4 bg-muted/50 border border-border rounded flex items-center justify-between gap-2">
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
                      window.location.hash = "app-builder";
                    }}
                  >
                    <ExternalLink className="h-3 w-3 mr-1" />
                    App Builder
                  </Button>
                </div>
              )}
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
              <JsonEditor value={rawResult} readOnly showToolbar={false} />
            </div>
          </ScrollArea>
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
