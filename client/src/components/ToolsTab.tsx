import { useState, useEffect } from "react";
import { useLogger } from "@/hooks/use-logger";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
import { Wrench, Play, RefreshCw, ChevronRight } from "lucide-react";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import type { MCPToolType } from "@mastra/core/mcp";
import { MastraMCPServerDefinition } from "@/lib/types";
import { ElicitationDialog } from "./ElicitationDialog";

interface Tool {
  name: string;
  description?: string;
  inputSchema: any;
  outputSchema?: Record<string, unknown>;
  toolType?: MCPToolType;
}

interface ToolsTabProps {
  serverConfig?: MastraMCPServerDefinition;
}

interface FormField {
  name: string;
  type: string;
  description?: string;
  required: boolean;
  value: any;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
}

interface ElicitationRequest {
  requestId: string;
  message: string;
  schema: any;
  timestamp: string;
}

export function ToolsTab({ serverConfig }: ToolsTabProps) {
  const logger = useLogger("ToolsTab");
  const [tools, setTools] = useState<Record<string, Tool>>({});
  const [selectedTool, setSelectedTool] = useState<string>("");
  const [formFields, setFormFields] = useState<FormField[]>([]);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchingTools, setFetchingTools] = useState(false);
  const [error, setError] = useState<string>("");
  const [eventSource, setEventSource] = useState<EventSource | null>(null);
  const [elicitationRequest, setElicitationRequest] =
    useState<ElicitationRequest | null>(null);
  const [elicitationLoading, setElicitationLoading] = useState(false);

  useEffect(() => {
    if (serverConfig) {
      fetchTools();
    }

    // Cleanup EventSource on unmount
    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [serverConfig, logger]);

  useEffect(() => {
    if (selectedTool && tools[selectedTool]) {
      generateFormFields(tools[selectedTool].inputSchema);
    }
  }, [selectedTool, tools, logger]);

  const getServerConfig = (): MastraMCPServerDefinition | null => {
    if (!serverConfig) return null;
    return serverConfig;
  };

  const fetchTools = async () => {
    const config = getServerConfig();
    if (!config) {
      logger.warn("Cannot fetch tools: no server config available");
      return;
    }

    logger.info("Starting tool fetch", {
      serverConfig: config,
    });

    // Close existing EventSource if any
    if (eventSource) {
      eventSource.close();
      setEventSource(null);
    }

    setFetchingTools(true);
    setError("");
    setTools({});

    const fetchStartTime = Date.now();

    try {
      const response = await fetch("/api/mcp/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "list",
          serverConfig: config,
        }),
      });

      if (!response.ok) {
        const errorMsg = `HTTP error! status: ${response.status}`;
        logger.error("Tools fetch HTTP error", { status: response.status });
        throw new Error(errorMsg);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        const errorMsg = "No response body";
        logger.error("Tools fetch error: no response body");
        throw new Error(errorMsg);
      }

      let toolCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        const chunk = decoder.decode(value);
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") {
              setFetchingTools(false);
              return;
            }

            try {
              const parsed = JSON.parse(data);
              if (parsed.type === "tools_list") {
                toolCount = Object.keys(parsed.tools || {}).length;
                setTools(parsed.tools || {});
                const fetchDuration = Date.now() - fetchStartTime;
                logger.info("Tools fetch completed successfully", {
                  serverConfig: config,
                  toolCount,
                  duration: fetchDuration,
                  tools: parsed.tools,
                });
              } else if (parsed.type === "tool_error") {
                logger.error("Tools fetch error from server", {
                  error: parsed.error,
                });
                setError(parsed.error);
                setFetchingTools(false);
                return;
              }
            } catch (parseError) {
              logger.warn("Failed to parse SSE data", {
                data,
                error: parseError,
              });
            }
          }
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      logger.error(
        "Tools fetch network error",
        { error: errorMsg },
        err instanceof Error ? err : undefined,
      );
      setError("Network error fetching tools");
    } finally {
      setFetchingTools(false);
    }
  };

  const generateFormFields = (schema: any) => {
    if (!schema || !schema.properties) {
      setFormFields([]);
      return;
    }

    const fields: FormField[] = [];
    const required = schema.required || [];

    Object.entries(schema.properties).forEach(([key, prop]: [string, any]) => {
      const fieldType = prop.enum ? "enum" : prop.type || "string";
      fields.push({
        name: key,
        type: fieldType,
        description: prop.description,
        required: required.includes(key),
        value: getDefaultValue(fieldType, prop.enum),
        enum: prop.enum,
        minimum: prop.minimum,
        maximum: prop.maximum,
        pattern: prop.pattern,
      });
    });

    setFormFields(fields);
  };

  const getDefaultValue = (type: string, enumValues?: string[]) => {
    switch (type) {
      case "enum":
        return enumValues?.[0] || "";
      case "string":
        return "";
      case "number":
      case "integer":
        return "";
      case "boolean":
        return false;
      case "array":
        return [];
      case "object":
        return {};
      default:
        return "";
    }
  };

  const updateFieldValue = (fieldName: string, value: any) => {
    setFormFields((prev) =>
      prev.map((field) =>
        field.name === fieldName ? { ...field, value } : field,
      ),
    );
  };

  const buildParameters = (): Record<string, any> => {
    const params: Record<string, any> = {};
    let processedFields = 0;
    let validationErrors = 0;

    formFields.forEach((field) => {
      if (
        field.value !== "" &&
        field.value !== null &&
        field.value !== undefined
      ) {
        let processedValue = field.value;
        processedFields++;

        try {
          if (field.type === "number" || field.type === "integer") {
            processedValue = Number(field.value);
            if (isNaN(processedValue)) {
              logger.warn("Invalid number value for field", {
                fieldName: field.name,
                value: field.value,
              });
              validationErrors++;
            }
          } else if (field.type === "boolean") {
            processedValue = Boolean(field.value);
          } else if (field.type === "array" || field.type === "object") {
            processedValue = JSON.parse(field.value);
          }

          params[field.name] = processedValue;
        } catch (parseError) {
          logger.warn("Failed to process field value", {
            fieldName: field.name,
            type: field.type,
            value: field.value,
            error: parseError,
          });
          validationErrors++;
          // Use raw value as fallback
          params[field.name] = field.value;
        }
      }
    });

    return params;
  };

  const executeTool = async () => {
    if (!selectedTool) {
      logger.warn("Cannot execute tool: no tool selected");
      return;
    }

    const config = getServerConfig();
    if (!config) {
      logger.warn("Cannot execute tool: no server config available");
      return;
    }

    setLoading(true);
    setError("");
    setResult(null);

    const executionStartTime = Date.now();

    try {
      const params = buildParameters();
      logger.info("Starting tool execution", {
        toolName: selectedTool,
        parameters: params,
      });
      const response = await fetch("/api/mcp/tools", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "execute",
          serverConfig: config,
          toolName: selectedTool,
          parameters: params,
        }),
      });

      if (!response.ok) {
        const errorMsg = `HTTP error! status: ${response.status}`;
        logger.error("Tool execution HTTP error", {
          toolName: selectedTool,
          status: response.status,
        });
        throw new Error(errorMsg);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        const errorMsg = "No response body";
        logger.error("Tool execution error: no response body", {
          toolName: selectedTool,
        });
        throw new Error(errorMsg);
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        const chunk = decoder.decode(value);
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") {
              setLoading(false);
              return;
            }

            try {
              const parsed = JSON.parse(data);

              if (parsed.type === "tool_result") {
                const result = parsed.result;
                const executionDuration = Date.now() - executionStartTime;
                logger.info("Tool execution completed successfully", {
                  toolName: selectedTool,
                  duration: executionDuration,
                  result: result,
                });
                setResult(result);
              } else if (parsed.type === "tool_error") {
                logger.error("Tool execution error from server", {
                  toolName: selectedTool,
                  error: parsed.error,
                });
                setError(parsed.error);
                setLoading(false);
                return;
              } else if (parsed.type === "elicitation_request") {
                setElicitationRequest({
                  requestId: parsed.requestId,
                  message: parsed.message,
                  schema: parsed.schema,
                  timestamp: parsed.timestamp,
                });
              } else if (parsed.type === "elicitation_complete") {
                setElicitationRequest(null);
              }
            } catch (parseError) {
              logger.warn("Failed to parse tool execution SSE data", {
                toolName: selectedTool,
                data,
                error: parseError,
              });
            }
          }
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      logger.error(
        "Tool execution network error",
        {
          toolName: selectedTool,
          error: errorMsg,
        },
        err instanceof Error ? err : undefined,
      );
      setError("Error executing tool");
    } finally {
      setLoading(false);
    }
  };

  const handleElicitationResponse = async (
    action: "accept" | "decline" | "cancel",
    parameters?: Record<string, any>,
  ) => {
    if (!elicitationRequest) {
      logger.warn("Cannot handle elicitation response: no active request");
      return;
    }

    setElicitationLoading(true);

    try {
      let responseData = null;
      if (action === "accept") {
        responseData = {
          action: "accept",
          content: parameters || {},
        };
      } else {
        responseData = {
          action,
        };
      }

      const response = await fetch("/api/mcp/tools", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "respond",
          requestId: elicitationRequest.requestId,
          response: responseData,
        }),
      });

      if (!response.ok) {
        const errorMsg = `HTTP error! status: ${response.status}`;
        logger.error("Elicitation response HTTP error", {
          requestId: elicitationRequest.requestId,
          action,
          status: response.status,
        });
        throw new Error(errorMsg);
      }

      setElicitationRequest(null);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      logger.error(
        "Error responding to elicitation request",
        {
          requestId: elicitationRequest.requestId,
          action,
          error: errorMsg,
        },
        err instanceof Error ? err : undefined,
      );
      setError("Error responding to elicitation request");
    } finally {
      setElicitationLoading(false);
    }
  };

  const toolNames = Object.keys(tools);

  if (!serverConfig) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-center text-muted-foreground font-medium">
            Please select a server to view tools
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="h-[calc(100vh-120px)] flex flex-col">
      <ResizablePanelGroup direction="vertical" className="flex-1">
        {/* Top Section - Tools and Parameters */}
        <ResizablePanel defaultSize={70} minSize={30}>
          <ResizablePanelGroup direction="horizontal" className="h-full">
            {/* Left Panel - Tools List */}
            <ResizablePanel defaultSize={30} minSize={20} maxSize={50}>
              <div className="h-full flex flex-col border-r border-border bg-background">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-4 border-b border-border bg-background">
                  <div className="flex items-center gap-3">
                    <Wrench className="h-3 w-3 text-muted-foreground" />
                    <h2 className="text-xs font-semibold text-foreground">
                      Tools
                    </h2>
                    <Badge variant="secondary" className="text-xs font-mono">
                      {toolNames.length}
                    </Badge>
                  </div>
                  <Button
                    onClick={fetchTools}
                    variant="ghost"
                    size="sm"
                    disabled={fetchingTools}
                  >
                    <RefreshCw
                      className={`h-3 w-3 ${fetchingTools ? "animate-spin" : ""} cursor-pointer`}
                    />
                  </Button>
                </div>

                {/* Tools List */}
                <div className="flex-1 overflow-hidden">
                  <ScrollArea className="h-full">
                    <div className="p-2">
                      {fetchingTools ? (
                        <div className="flex flex-col items-center justify-center py-16 text-center">
                          <div className="w-8 h-8 bg-muted rounded-full flex items-center justify-center mb-3">
                            <RefreshCw className="h-4 w-4 text-muted-foreground animate-spin cursor-pointer" />
                          </div>
                          <p className="text-xs text-muted-foreground font-semibold mb-1">
                            Loading tools...
                          </p>
                          <p className="text-xs text-muted-foreground/70">
                            Fetching available tools from server
                          </p>
                        </div>
                      ) : toolNames.length === 0 ? (
                        <div className="text-center py-8">
                          <p className="text-sm text-muted-foreground">
                            No tools available
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-1">
                          {toolNames.map((name) => (
                            <div
                              key={name}
                              className={`cursor-pointer transition-all duration-200 hover:bg-muted/30 dark:hover:bg-muted/50 p-3 rounded-md mx-2 ${
                                selectedTool === name
                                  ? "bg-muted/50 dark:bg-muted/50 shadow-sm border border-border ring-1 ring-ring/20"
                                  : "hover:shadow-sm"
                              }`}
                              onClick={() => {
                                setSelectedTool(name);
                              }}
                            >
                              <div className="flex items-start gap-3">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1">
                                    <code className="font-mono text-xs font-medium text-foreground bg-muted px-1.5 py-0.5 rounded border border-border">
                                      {name}
                                    </code>
                                  </div>
                                  {tools[name]?.description && (
                                    <p className="text-xs mt-2 line-clamp-2 leading-relaxed text-muted-foreground">
                                      {tools[name].description}
                                    </p>
                                  )}
                                </div>
                                <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0 mt-1" />
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </ScrollArea>
                </div>
              </div>
            </ResizablePanel>

            <ResizableHandle withHandle />

            {/* Right Panel - Parameters */}
            <ResizablePanel defaultSize={70} minSize={50}>
              <div className="h-full flex flex-col bg-background">
                {selectedTool ? (
                  <>
                    {/* Header */}
                    <div className="flex items-center justify-between px-6 py-5 border-b border-border bg-background">
                      <div className="space-y-2">
                        <div className="flex items-center gap-3">
                          <code className="font-mono font-semibold text-foreground bg-muted px-2 py-1 rounded-md border border-border text-xs">
                            {selectedTool}
                          </code>
                        </div>
                      </div>
                      <Button
                        onClick={executeTool}
                        disabled={loading || !selectedTool}
                        className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm transition-all duration-200 cursor-pointer"
                        size="sm"
                      >
                        {loading ? (
                          <>
                            <RefreshCw className="h-3 w-3 mr-1.5 animate-spin cursor-pointer" />
                            <span className="font-mono text-xs">
                              {elicitationRequest ? "Waiting..." : "Running"}
                            </span>
                          </>
                        ) : (
                          <>
                            <Play className="h-3 w-3 mr-1.5 cursor-pointer" />
                            <span className="font-mono text-xs">Execute</span>
                          </>
                        )}
                      </Button>
                    </div>

                    {/* Description */}
                    {tools[selectedTool]?.description && (
                      <div className="px-6 py-4 bg-muted/50 border-b border-border">
                        <p className="text-xs text-muted-foreground leading-relaxed font-medium">
                          {tools[selectedTool].description}
                        </p>
                      </div>
                    )}

                    {/* Parameters */}
                    <div className="flex-1 overflow-hidden">
                      <ScrollArea className="h-full">
                        <div className="px-6 py-6">
                          {formFields.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-16 text-center">
                              <div className="w-10 h-10 bg-muted rounded-full flex items-center justify-center mb-3">
                                <Play className="h-4 w-4 text-muted-foreground" />
                              </div>
                              <p className="text-xs text-muted-foreground font-semibold mb-1">
                                No parameters required
                              </p>
                              <p className="text-xs text-muted-foreground/70">
                                This tool can be executed directly
                              </p>
                            </div>
                          ) : (
                            <div className="space-y-8">
                              {formFields.map((field) => (
                                <div key={field.name} className="group">
                                  <div className="flex items-start justify-between mb-3">
                                    <div className="space-y-1">
                                      <div className="flex items-center gap-3">
                                        <code className="font-mono text-xs font-semibold text-foreground bg-muted px-1.5 py-0.5 rounded border border-border">
                                          {field.name}
                                        </code>
                                        {field.required && (
                                          <div
                                            className="w-1.5 h-1.5 bg-amber-400 dark:bg-amber-500 rounded-full"
                                            title="Required field"
                                          />
                                        )}
                                      </div>
                                      {field.description && (
                                        <p className="text-xs text-muted-foreground leading-relaxed max-w-md font-medium">
                                          {field.description}
                                        </p>
                                      )}
                                    </div>
                                    <Badge
                                      variant="secondary"
                                      className="text-xs font-mono font-medium"
                                    >
                                      {field.type}
                                    </Badge>
                                  </div>

                                  <div className="space-y-2">
                                    {field.type === "enum" ? (
                                      <Select
                                        value={field.value}
                                        onValueChange={(value) =>
                                          updateFieldValue(field.name, value)
                                        }
                                      >
                                        <SelectTrigger className="w-full bg-background border-border hover:border-border/80 focus:border-ring focus:ring-0 font-medium text-xs">
                                          <SelectValue
                                            placeholder="Select an option"
                                            className="font-mono text-xs"
                                          />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {field.enum?.map((option) => (
                                            <SelectItem
                                              key={option}
                                              value={option}
                                              className="font-mono text-xs"
                                            >
                                              {option}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    ) : field.type === "boolean" ? (
                                      <div className="flex items-center space-x-3 py-2">
                                        <input
                                          type="checkbox"
                                          checked={field.value}
                                          onChange={(e) =>
                                            updateFieldValue(
                                              field.name,
                                              e.target.checked,
                                            )
                                          }
                                          className="w-4 h-4 text-primary bg-background border-border rounded focus:ring-ring focus:ring-2"
                                        />
                                        <span className="text-xs text-foreground font-medium">
                                          {field.value ? "Enabled" : "Disabled"}
                                        </span>
                                      </div>
                                    ) : field.type === "array" ||
                                      field.type === "object" ? (
                                      <Textarea
                                        value={
                                          typeof field.value === "string"
                                            ? field.value
                                            : JSON.stringify(
                                                field.value,
                                                null,
                                                2,
                                              )
                                        }
                                        onChange={(e) =>
                                          updateFieldValue(
                                            field.name,
                                            e.target.value,
                                          )
                                        }
                                        placeholder={`Enter ${field.type} as JSON`}
                                        className="font-mono text-xs h-20 bg-background border-border hover:border-border/80 focus:border-ring focus:ring-0 resize-none"
                                      />
                                    ) : (
                                      <Input
                                        type={
                                          field.type === "number" ||
                                          field.type === "integer"
                                            ? "number"
                                            : "text"
                                        }
                                        value={field.value}
                                        onChange={(e) =>
                                          updateFieldValue(
                                            field.name,
                                            e.target.value,
                                          )
                                        }
                                        placeholder={`Enter ${field.name}`}
                                        className="bg-background border-border hover:border-border/80 focus:border-ring focus:ring-0 font-medium text-xs"
                                      />
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </ScrollArea>
                    </div>
                  </>
                ) : (
                  <div className="h-full flex items-center justify-center">
                    <div className="text-center">
                      <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mx-auto mb-3">
                        <Wrench className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <p className="text-xs font-semibold text-foreground mb-1">
                        Select a tool
                      </p>
                      <p className="text-xs text-muted-foreground font-medium">
                        Choose a tool from the left to configure parameters
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Bottom Panel - Results */}
        <ResizablePanel defaultSize={30} minSize={15} maxSize={70}>
          <div className="h-full flex flex-col border-t border-border bg-background">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h2 className="text-xs font-semibold text-foreground">
                Response
              </h2>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-hidden">
              {error ? (
                <div className="p-4">
                  <div className="p-3 bg-destructive/10 border border-destructive/20 rounded text-destructive text-xs font-medium">
                    {error}
                  </div>
                </div>
              ) : result ? (
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
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-xs text-muted-foreground font-medium">
                    Execute a tool to see results here
                  </p>
                </div>
              )}
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      <ElicitationDialog
        elicitationRequest={elicitationRequest}
        onResponse={handleElicitationResponse}
        loading={elicitationLoading}
      />
    </div>
  );
}
