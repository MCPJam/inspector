import { useState, useEffect, useMemo } from "react";
import { useLogger } from "@/hooks/use-logger";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
import { Wrench } from "lucide-react";
import { EmptyState } from "./ui/empty-state";
import "react18-json-view/src/style.css";
import type { MCPToolType } from "@mastra/core/mcp";
import { ElicitationDialog } from "./ElicitationDialog";
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
  listSavedRequests,
  saveRequest,
  deleteRequest,
  duplicateRequest,
  updateRequestMeta,
} from "@/lib/request-storage";
import type { SavedRequest } from "@/lib/request-types";
import { MastraMCPServerDefinition } from "@mastra/mcp";

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

  const filteredSavedRequests = searchQuery.trim()
    ? savedRequests.filter((tool) => {
        const haystack = `${tool.title} ${tool?.description}`.toLowerCase();
        return haystack.includes(searchQuery.trim().toLowerCase());
      })
    : savedRequests;

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
      savedRequests={filteredSavedRequests}
      highlightedRequestId={highlightedRequestId}
      onLoadRequest={handleLoadRequest}
      onRenameRequest={handleRenameRequest}
      onDuplicateRequest={handleDuplicateRequest}
      onDeleteRequest={handleDeleteRequest}
    />
  );

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
      <EmptyState
        icon={Wrench}
        title="No Server Selected"
        description="Connect to an MCP server to explore and test its available tools."
      />
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
