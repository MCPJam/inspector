import { useState, useEffect, useMemo } from "react";
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
import { Wrench, Play, RefreshCw, CheckCircle, XCircle } from "lucide-react";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import type { MCPToolType } from "@mastra/core/mcp";
import { MastraMCPServerDefinition } from "@/shared/types.js";
import { ElicitationDialog } from "./ElicitationDialog";
import { TruncatedText } from "@/components/ui/truncated-text";
import { validateToolOutput } from "@/lib/schema-utils";
import { SearchInput } from "@/components/ui/search-input";
import { UIResourceRenderer } from "@mcp-ui/client";
import SaveRequestDialog from "./SaveRequestDialog";
import { ToolItem } from "./ToolItem";
import { SavedRequestItem } from "./SavedRequestItem";
import {
  listSavedRequests,
  saveRequest,
  deleteRequest,
  duplicateRequest,
  updateRequestMeta,
} from "@/lib/request-storage";
import type { SavedRequest } from "@/lib/request-types";
import { Save as SaveIcon, Trash2, Copy, Edit2 } from "lucide-react";

interface Tool {
  name: string;
  description?: string;
  inputSchema: any;
  outputSchema?: Record<string, unknown>;
  toolType?: MCPToolType;
}

interface ToolsTabProps {
  serverConfig?: MastraMCPServerDefinition;
  serverName?: string;
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

export function ToolsTab({ serverConfig, serverName }: ToolsTabProps) {
  const logger = useLogger("ToolsTab");
  const [tools, setTools] = useState<Record<string, Tool>>({});
  const [selectedTool, setSelectedTool] = useState<string>("");
  const [formFields, setFormFields] = useState<FormField[]>([]);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [showStructured, setShowStructured] = useState(false);
  const [structuredResult, setStructuredResult] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [validationErrors, setValidationErrors] = useState<
    any[] | null | undefined
  >(undefined);
  const [unstructuredValidationResult, setUnstructuredValidationResult] =
    useState<"not_applicable" | "valid" | "invalid_json" | "schema_mismatch">(
      "not_applicable",
    );
  const [loading, setLoading] = useState(false);
  const [fetchingTools, setFetchingTools] = useState(false);
  const [error, setError] = useState<string>("");
  const [eventSource, setEventSource] = useState<EventSource | null>(null);
  const [elicitationRequest, setElicitationRequest] =
    useState<ElicitationRequest | null>(null);
  const [elicitationLoading, setElicitationLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"tools" | "saved">("tools");
  const [highlightedRequestId, setHighlightedRequestId] = useState<
    string | null
  >(null);
  const serverKey = useMemo(() => {
    if (!serverConfig) return "none";
    try {
      if ((serverConfig as any).url) {
        return `http:${(serverConfig as any).url}`;
      }
      if ((serverConfig as any).command) {
        const args = ((serverConfig as any).args || []).join(" ");
        return `stdio:${(serverConfig as any).command} ${args}`.trim();
      }
      return JSON.stringify(serverConfig);
    } catch {
      return "unknown";
    }
  }, [serverConfig]);
  const [savedRequests, setSavedRequests] = useState<SavedRequest[]>([]);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null);
  const [dialogDefaults, setDialogDefaults] = useState<{
    title: string;
    description?: string;
  }>({ title: "" });

  useEffect(() => {
    if (serverConfig) {
      fetchTools();
    } else {
      // Clear tools state when server is disconnected
      setTools({});
      setSelectedTool("");
      setFormFields([]);
      setResult(null);
      setStructuredResult(null);
      setShowStructured(false);
      setValidationErrors(undefined);
      setUnstructuredValidationResult("not_applicable");
      setError("");
    }

    // Cleanup EventSource on unmount
    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [serverConfig, logger]);

  useEffect(() => {
    if (!serverConfig) return;
    setSavedRequests(listSavedRequests(serverKey));
  }, [serverKey, serverConfig]);

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

    // Clear all tools-related state when switching servers
    setFetchingTools(true);
    setError("");
    setTools({});
    setSelectedTool("");
    setFormFields([]);
    setResult(null);
    setStructuredResult(null);
    setShowStructured(false);
    setValidationErrors(undefined);
    setUnstructuredValidationResult("not_applicable");

    const fetchStartTime = Date.now();

    try {
      const response = await fetch("/api/mcp/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "list",
          serverConfig: { ...config, name: serverName },
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
                // console.log(parsed.tools, "parsed tools")
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

  // Attempt to extract an MCP-UI resource from a tool result in various shapes
  const getUIResourceFromResult = (rawResult: any): any | null => {
    if (!rawResult) return null;
    // Direct resource shape: { resource: {...} }
    const direct = (rawResult as any)?.resource;
    if (
      direct &&
      typeof direct === "object" &&
      typeof direct.uri === "string" &&
      direct.uri.startsWith("ui://")
    ) {
      return direct;
    }
    // MCP content array shape: { content: [{ type: 'resource', resource: {...}}] }
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

  const applyParametersToFields = (params: Record<string, any>) => {
    setFormFields((prev) =>
      prev.map((field) => {
        if (Object.prototype.hasOwnProperty.call(params, field.name)) {
          const raw = params[field.name];
          if (field.type === "array" || field.type === "object") {
            return { ...field, value: JSON.stringify(raw, null, 2) };
          }
          return { ...field, value: raw };
        }
        return field;
      }),
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
    setStructuredResult(null);
    setShowStructured(false);
    setValidationErrors(undefined);
    setUnstructuredValidationResult("not_applicable");

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
          serverConfig: { ...config, name: serverName },
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
                if (result.structuredContent) {
                  setStructuredResult(
                    result.structuredContent as Record<string, unknown>,
                  );
                  setShowStructured(true);
                }

                const currentTool = tools[selectedTool];
                if (currentTool && currentTool.outputSchema) {
                  const outputSchema = currentTool.outputSchema;

                  const validationReport = validateToolOutput(
                    result,
                    outputSchema,
                  );
                  setValidationErrors(validationReport.structuredErrors);
                  setUnstructuredValidationResult(
                    validationReport.unstructuredStatus,
                  );

                  if (validationReport.structuredErrors) {
                    logger.warn(
                      "Schema validation failed for structuredContent",
                      {
                        errors: validationReport.structuredErrors,
                      },
                    );
                  }
                  if (
                    validationReport.unstructuredStatus === "invalid_json" ||
                    validationReport.unstructuredStatus === "schema_mismatch"
                  ) {
                    logger.warn(
                      `Validation failed for raw content: ${validationReport.unstructuredStatus}`,
                    );
                  }
                }
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

  const handleSaveCurrent = () => {
    if (!selectedTool) return;
    setEditingRequestId(null);
    setDialogDefaults({ title: `${selectedTool}`, description: "" });
    setIsSaveDialogOpen(true);
  };

  const handleLoadRequest = (req: SavedRequest) => {
    setSelectedTool(req.toolName);
    // allow form fields to regenerate for the tool, then apply params
    setTimeout(() => applyParametersToFields(req.parameters), 50);
  };

  const handleDeleteRequest = (id: string) => {
    deleteRequest(serverKey, id);
    setSavedRequests(listSavedRequests(serverKey));
  };

  const handleDuplicateRequest = (req: SavedRequest) => {
    const duplicated = duplicateRequest(serverKey, req.id);
    setSavedRequests(listSavedRequests(serverKey));
    if (duplicated && duplicated.id) {
      setHighlightedRequestId(duplicated.id);
      setTimeout(() => setHighlightedRequestId(null), 2000);
    }
  };

  const handleRenameRequest = (req: SavedRequest) => {
    setEditingRequestId(req.id);
    setDialogDefaults({ title: req.title, description: req.description });
    setIsSaveDialogOpen(true);
  };

  // removed favorite feature

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
  const filteredToolNames = searchQuery.trim()
    ? toolNames.filter((name) => {
        const tool = tools[name];
        const haystack = `${name} ${tool?.description || ""}`.toLowerCase();
        return haystack.includes(searchQuery.trim().toLowerCase());
      })
    : toolNames;

  const renderLeftPanel = () => {
    return (
      <ResizablePanel defaultSize={35} minSize={20} maxSize={55}>
        <div className="h-full border-r border-border bg-background">
          {/* Tab Navigation */}
          <div className="border-b border-border">
            <div className="flex">
              <button
                onClick={() => setActiveTab("tools")}
                className={`px-4 py-3 text-xs font-medium border-b-2 transition-colors ${
                  activeTab === "tools"
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                Tools
              </button>
              <button
                onClick={() => setActiveTab("saved")}
                className={`px-4 py-3 text-xs font-medium border-b-2 transition-colors ${
                  activeTab === "saved"
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                Saved Requests
                {savedRequests.length > 0 && (
                  <span className="ml-2 bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs font-mono">
                    {savedRequests.length}
                  </span>
                )}
              </button>
            </div>
          </div>

          {/* Tab Content */}
          {activeTab === "tools" ? (
            <div className="h-[calc(100%-49px)] flex flex-col">
              {/* Tools Header */}
              <div className="px-4 py-4 border-b border-border bg-background space-y-3">
                <div className="flex items-center justify-between">
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
                <SearchInput
                  value={searchQuery}
                  onValueChange={setSearchQuery}
                  placeholder="Search tools by name or description"
                />
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
                    ) : filteredToolNames.length === 0 ? (
                      <div className="text-center py-8">
                        <p className="text-sm text-muted-foreground">
                          {toolNames.length === 0
                            ? "No tools available"
                            : "No tools match your search"}
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {filteredToolNames.map((name) => (
                          <ToolItem
                            key={name}
                            tool={tools[name]}
                            name={name}
                            isSelected={selectedTool === name}
                            onClick={() => setSelectedTool(name)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </div>
            </div>
          ) : (
            <div className="h-[calc(100%-49px)] flex flex-col">
              {/* Saved Requests Header */}
              <div className="px-4 py-4 border-b border-border bg-background space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <h2 className="text-xs font-semibold text-foreground">
                      Saved Requests
                    </h2>
                    <Badge variant="secondary" className="text-xs font-mono">
                      {savedRequests.length}
                    </Badge>
                  </div>
                </div>
              </div>

              {/* Saved Requests List */}
              <div className="flex-1 overflow-hidden">
                <ScrollArea className="h-full">
                  <div className="p-2 space-y-1">
                    {savedRequests.length === 0 ? (
                      <div className="text-center py-16">
                        <p className="text-xs text-muted-foreground">
                          No saved requests
                        </p>
                      </div>
                    ) : (
                      savedRequests.map((request) => (
                        <SavedRequestItem
                          key={request.id}
                          request={request}
                          isHighlighted={highlightedRequestId === request.id}
                          onLoad={handleLoadRequest}
                          onRename={handleRenameRequest}
                          onDuplicate={handleDuplicateRequest}
                          onDelete={handleDeleteRequest}
                        />
                      ))
                    )}
                  </div>
                </ScrollArea>
              </div>
            </div>
          )}
        </div>
      </ResizablePanel>
    );
  };

  const renderRightPanel = () => {
    return (
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
                <div className="flex items-center gap-2">
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
                  <Button
                    onClick={handleSaveCurrent}
                    variant="outline"
                    size="sm"
                    disabled={!selectedTool}
                  >
                    <SaveIcon className="h-3 w-3 mr-1" />
                    <span className="font-mono text-xs">Save</span>
                  </Button>
                </div>
              </div>

              {/* Description */}
              {tools[selectedTool]?.description && (
                <div className="px-6 py-4 bg-muted/50 border-b border-border">
                  <TruncatedText
                    text={tools[selectedTool].description}
                    title={tools[selectedTool].name}
                    maxLength={400}
                  />
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
                                      : JSON.stringify(field.value, null, 2)
                                  }
                                  onChange={(e) =>
                                    updateFieldValue(field.name, e.target.value)
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
                                    updateFieldValue(field.name, e.target.value)
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
    );
  };

  const renderResultsPanel = () => {
    return (
      <ResizablePanel defaultSize={40} minSize={15} maxSize={85}>
        <div className="h-full flex flex-col border-t border-border bg-background">
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-border">
            <div className="flex items-center gap-4">
              <h2 className="text-xs font-semibold text-foreground">
                Response
              </h2>
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

            {structuredResult && (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={!showStructured ? "default" : "outline"}
                  onClick={() => setShowStructured(false)}
                >
                  Raw Output
                </Button>
                <Button
                  size="sm"
                  variant={showStructured ? "default" : "outline"}
                  onClick={() => setShowStructured(true)}
                >
                  Structured Output
                </Button>
              </div>
            )}
          </div>

          {/* Content */}
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
                  <span className="text-sm font-semibold text-destructive mb-2">{`${validationErrors[0].instancePath.slice(1)} ${validationErrors[0].message}`}</span>
                </div>
              </div>
            ) : showStructured &&
              structuredResult &&
              validationErrors === null ? (
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
              <div className="flex-1 overflow-auto">
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
                  {(() => {
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
                            logger.info("MCP-UI Action received", {
                              type: evt.type,
                              payload: evt.payload,
                            });

                            try {
                              switch (evt.type) {
                                case "tool":
                                  if (evt.payload?.toolName) {
                                    logger.info("Executing tool from MCP-UI", {
                                      toolName: evt.payload.toolName,
                                      params: evt.payload.params,
                                    });

                                    await fetch("/api/mcp/tools", {
                                      method: "POST",
                                      headers: {
                                        "Content-Type": "application/json",
                                      },
                                      body: JSON.stringify({
                                        action: "execute",
                                        toolName: evt.payload.toolName,
                                        parameters: evt.payload.params || {},
                                        serverConfig: getServerConfig(),
                                      }),
                                    });
                                  }
                                  break;

                                case "prompt":
                                  if (evt.payload?.prompt) {
                                    logger.info(
                                      "Processing prompt from MCP-UI",
                                      {
                                        prompt: evt.payload.prompt,
                                      },
                                    );
                                    // For now, just log the prompt
                                    // In a full implementation, this could integrate with chat or other prompt handling
                                    console.log(
                                      "MCP-UI Prompt Request:",
                                      evt.payload.prompt,
                                    );
                                  }
                                  break;

                                case "intent":
                                  if (evt.payload?.intent) {
                                    logger.info(
                                      "Processing intent from MCP-UI",
                                      {
                                        intent: evt.payload.intent,
                                        params: evt.payload.params,
                                      },
                                    );

                                    // Try to handle intent by calling a handleIntent tool if it exists
                                    try {
                                      await fetch("/api/mcp/tools", {
                                        method: "POST",
                                        headers: {
                                          "Content-Type": "application/json",
                                        },
                                        body: JSON.stringify({
                                          action: "execute",
                                          toolName: "handleIntent",
                                          parameters: {
                                            intent: evt.payload.intent,
                                            params: evt.payload.params || {},
                                          },
                                          serverConfig: getServerConfig(),
                                        }),
                                      });
                                    } catch (error) {
                                      // If no handleIntent tool exists, just log the intent
                                      logger.warn(
                                        "No handleIntent tool available, intent logged only",
                                        {
                                          intent: evt.payload.intent,
                                          error,
                                        },
                                      );
                                    }
                                  }
                                  break;

                                case "notify":
                                  if (evt.payload?.message) {
                                    logger.info("Notification from MCP-UI", {
                                      message: evt.payload.message,
                                    });
                                    // Handle notifications - could show toast, update UI, etc.
                                    console.log(
                                      "MCP-UI Notification:",
                                      evt.payload.message,
                                    );
                                  }
                                  break;

                                case "link":
                                  if (evt.payload?.url) {
                                    logger.info("Opening link from MCP-UI", {
                                      url: evt.payload.url,
                                    });
                                    window.open(
                                      evt.payload.url,
                                      "_blank",
                                      "noopener,noreferrer",
                                    );
                                  }
                                  break;
                                default:
                                  logger.warn("Unknown MCP-UI action type", {});
                              }
                            } catch (error) {
                              logger.error("Error handling MCP-UI action", {
                                type: evt.type,
                                payload: evt.payload,
                                error:
                                  error instanceof Error
                                    ? error.message
                                    : String(error),
                              });
                            }
                          }}
                        />
                      );
                    }
                    return (
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
                    );
                  })()}
                </div>
              </div>
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
    );
  };

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
            {/* Left Panel - Tabbed Interface */}
            {renderLeftPanel()}

            <ResizableHandle withHandle />

            {/* Right Panel - Parameters */}
            {renderRightPanel()}
          </ResizablePanelGroup>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Bottom Panel - Results */}
        {renderResultsPanel()}
      </ResizablePanelGroup>

      <ElicitationDialog
        elicitationRequest={elicitationRequest}
        onResponse={handleElicitationResponse}
        loading={elicitationLoading}
      />

      <SaveRequestDialog
        open={isSaveDialogOpen}
        defaultTitle={dialogDefaults.title}
        defaultDescription={dialogDefaults.description}
        onCancel={() => setIsSaveDialogOpen(false)}
        onSave={({ title, description }) => {
          if (editingRequestId) {
            updateRequestMeta(serverKey, editingRequestId, {
              title,
              description,
            });
            setSavedRequests(listSavedRequests(serverKey));
            setEditingRequestId(null);
            setIsSaveDialogOpen(false);
            // Switch to saved tab and highlight the edited request
            setActiveTab("saved");
            setHighlightedRequestId(editingRequestId);
            setTimeout(() => setHighlightedRequestId(null), 2000);
            return;
          }
          const params = buildParameters();
          const newRequest = saveRequest(serverKey, {
            title,
            description,
            toolName: selectedTool,
            parameters: params,
          });
          setSavedRequests(listSavedRequests(serverKey));
          setIsSaveDialogOpen(false);
          // Switch to saved tab and highlight the new request
          setActiveTab("saved");
          if (newRequest && newRequest.id) {
            setHighlightedRequestId(newRequest.id);
            setTimeout(() => setHighlightedRequestId(null), 2000);
          }
        }}
      />
    </div>
  );
}
