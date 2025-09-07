import { useState, useEffect, useMemo } from "react";
import { useLogger } from "@/hooks/use-logger";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
import { Play, RefreshCw, Wrench } from "lucide-react";
import "react18-json-view/src/style.css";
import type { MCPToolType } from "@mastra/core/mcp";
import { ElicitationDialog } from "./ElicitationDialog";
import { TruncatedText } from "@/components/ui/truncated-text";
import { validateToolOutput } from "@/lib/schema-utils";
import { ResultsPanel } from "./tools/ResultsPanel";
import { ToolsSidebar } from "./tools/ToolsSidebar";
import { ParametersPanel } from "./tools/ParametersPanel";
import {
  listTools,
  executeToolApi,
  respondToElicitationApi,
} from "@/lib/mcp-tools-api";
import {
  generateFormFieldsFromSchema,
  applyParametersToFields as applyParamsToFields,
  buildParametersFromFields,
  type FormField as ToolFormField,
} from "@/lib/tool-form";
import SaveRequestDialog from "./SaveRequestDialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  listSavedRequests,
  saveRequest,
  deleteRequest,
  duplicateRequest,
  updateRequestMeta,
} from "@/lib/request-storage";
import type { SavedRequest } from "@/lib/request-types";
import { Save as SaveIcon } from "lucide-react";
import { MastraMCPServerDefinition } from "@mastra/mcp";
import { ScrollArea } from "./ui/scroll-area";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";

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

type FormField = ToolFormField;

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

  const fetchTools = async () => {
    if (!serverName) {
      logger.warn("Cannot fetch tools: no serverId available");
      return;
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
      const data = await listTools(serverName);
      const toolMap = data.tools || {};
      const toolCount = Object.keys(toolMap).length;
      setTools(toolMap);
      const fetchDuration = Date.now() - fetchStartTime;
      logger.info("Tools fetch completed successfully", {
        serverId: serverName,
        toolCount,
        duration: fetchDuration,
        tools: toolMap,
      });
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
    setFormFields(generateFormFieldsFromSchema(schema));
  };

  const updateFieldValue = (fieldName: string, value: any) => {
    setFormFields((prev) =>
      prev.map((field) =>
        field.name === fieldName ? { ...field, value } : field,
      ),
    );
  };

  const applyParametersToFields = (params: Record<string, any>) => {
    setFormFields((prev) => applyParamsToFields(prev, params));
  };

  const buildParameters = (): Record<string, any> =>
    buildParametersFromFields(formFields, (msg, ctx) => logger.warn(msg, ctx));

  const executeTool = async () => {
    if (!selectedTool) {
      logger.warn("Cannot execute tool: no tool selected");
      return;
    }

    if (!serverName) {
      logger.warn("Cannot execute tool: no serverId available");
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
      const data = await executeToolApi(serverName, selectedTool, params);
      if (data.status === "completed") {
        const result = data.result;
        const executionDuration = Date.now() - executionStartTime;
        logger.info("Tool execution completed successfully", {
          toolName: selectedTool,
          duration: executionDuration,
          result,
        });
        setResult(result);
        if (result?.structuredContent) {
          setStructuredResult(
            result.structuredContent as Record<string, unknown>,
          );
          setShowStructured(true);
        }

        const currentTool = tools[selectedTool];
        if (currentTool && currentTool.outputSchema) {
          const outputSchema = currentTool.outputSchema;
          const validationReport = validateToolOutput(result, outputSchema);
          setValidationErrors(validationReport.structuredErrors);
          setUnstructuredValidationResult(validationReport.unstructuredStatus);
          if (validationReport.structuredErrors) {
            logger.warn("Schema validation failed for structuredContent", {
              errors: validationReport.structuredErrors,
            });
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
      } else if (data.status === "elicitation_required") {
        setElicitationRequest({
          requestId: data.requestId,
          message: data.message,
          schema: data.schema,
          timestamp: data.timestamp,
        });
      } else if (data.error) {
        setError(data.error);
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

      const data = await respondToElicitationApi(
        elicitationRequest.requestId,
        responseData,
      );
      if (data.status === "completed") {
        // Show final result
        setElicitationRequest(null);
        const result = data.result;
        setResult(result);
        if (result?.structuredContent) {
          setStructuredResult(
            result.structuredContent as Record<string, unknown>,
          );
          setShowStructured(true);
        }

        const currentTool = tools[selectedTool];
        if (currentTool && currentTool.outputSchema) {
          const outputSchema = currentTool.outputSchema;
          const validationReport = validateToolOutput(result, outputSchema);
          setValidationErrors(validationReport.structuredErrors);
          setUnstructuredValidationResult(validationReport.unstructuredStatus);
        }
      } else if (data.status === "elicitation_required") {
        // Next elicitation round
        setElicitationRequest({
          requestId: data.requestId,
          message: data.message,
          schema: data.schema,
          timestamp: data.timestamp,
        });
      } else if (data.error) {
        setError(data.error);
      }
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

  const renderLeftPanel = () => (
    <ToolsSidebar
      activeTab={activeTab}
      onChangeTab={setActiveTab}
      tools={tools}
      toolNames={toolNames}
      filteredToolNames={filteredToolNames}
      selectedToolName={selectedTool}
      fetchingTools={fetchingTools}
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
      onRefresh={fetchTools}
      onSelectTool={setSelectedTool}
      savedRequests={savedRequests}
      highlightedRequestId={highlightedRequestId}
      onLoadRequest={handleLoadRequest}
      onRenameRequest={handleRenameRequest}
      onDuplicateRequest={handleDuplicateRequest}
      onDeleteRequest={handleDeleteRequest}
    />
  );

  const renderRightPanelLegacy = () => {
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

  const renderRightPanel = () =>
    selectedTool ? (
      <ParametersPanel
        selectedTool={selectedTool}
        toolDescription={tools[selectedTool]?.description}
        formFields={formFields}
        loading={loading}
        waitingOnElicitation={!!elicitationRequest}
        onExecute={executeTool}
        onSave={handleSaveCurrent}
        onFieldChange={updateFieldValue}
      />
    ) : (
      <ResizablePanel defaultSize={70} minSize={50}>
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
      </ResizablePanel>
    );

  const renderResultsPanel = () => (
    <ResizablePanel defaultSize={40} minSize={15} maxSize={85}>
      <ResultsPanel
        error={error}
        showStructured={showStructured}
        onToggleStructured={(s) => setShowStructured(s)}
        structuredResult={structuredResult}
        result={result}
        validationErrors={validationErrors}
        unstructuredValidationResult={unstructuredValidationResult}
        onExecuteFromUI={async (name, params) => {
          await fetch("/api/mcp/tools/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              toolName: name,
              parameters: params || {},
              ...(serverName ? { serverId: serverName } : {}),
            }),
          });
        }}
        onHandleIntent={async (intent, params) => {
          await fetch("/api/mcp/tools/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              toolName: "handleIntent",
              parameters: { intent, params: params || {} },
              ...(serverName ? { serverId: serverName } : {}),
            }),
          });
        }}
      />
    </ResizablePanel>
  );

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
            {renderLeftPanel()}
            <ResizableHandle withHandle />
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
