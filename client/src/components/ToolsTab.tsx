import { useEffect, useMemo, useState } from "react";
import type {
  CallToolResult,
  ElicitRequest,
  ElicitResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Wrench } from "lucide-react";
import { MastraMCPServerDefinition } from "@mastra/mcp";
import { ElicitationDialog } from "./ElicitationDialog";
import { EmptyState } from "./ui/empty-state";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./ui/resizable";
import { ParametersPanel } from "./tools/ParametersPanel";
import { ResultsPanel } from "./tools/ResultsPanel";
import { ToolsSidebar } from "./tools/ToolsSidebar";
import SaveRequestDialog from "./tools/SaveRequestDialog";
import {
  applyParametersToFields as applyParamsToFields,
  buildParametersFromFields,
  generateFormFieldsFromSchema,
  type FormField as ToolFormField,
} from "@/lib/tool-form";
import {
  deleteRequest,
  duplicateRequest,
  listSavedRequests,
  saveRequest,
  updateRequestMeta,
} from "@/lib/request-storage";
import type { SavedRequest } from "@/lib/request-types";
import { useLogger } from "@/hooks/use-logger";
import {
  executeToolApi,
  listTools,
  respondToElicitationApi,
  type ToolExecutionResponse,
} from "@/lib/mcp-tools-api";
import { validateToolOutput } from "@/lib/schema-utils";
import "react18-json-view/src/style.css";

type ToolMap = Record<string, Tool>;
type FormField = ToolFormField;

type ActiveElicitation = {
  executionId: string;
  requestId: string;
  request: ElicitRequest["params"];
  timestamp: string;
};

export type DialogElicitation = {
  requestId: string;
  message: string;
  schema?: Record<string, unknown>;
  timestamp: string;
};

interface ToolsTabProps {
  serverConfig?: MastraMCPServerDefinition;
  serverName?: string;
}

export function ToolsTab({ serverConfig, serverName }: ToolsTabProps) {
  const logger = useLogger("ToolsTab");
  const [tools, setTools] = useState<ToolMap>({});
  const [selectedTool, setSelectedTool] = useState<string>("");
  const [formFields, setFormFields] = useState<FormField[]>([]);
  const [result, setResult] = useState<CallToolResult | null>(null);
  const [structuredResult, setStructuredResult] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [showStructured, setShowStructured] = useState(false);
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
  const [activeElicitation, setActiveElicitation] =
    useState<ActiveElicitation | null>(null);
  const [elicitationLoading, setElicitationLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"tools" | "saved">("tools");
  const [highlightedRequestId, setHighlightedRequestId] = useState<
    string | null
  >(null);
  const [lastToolCallId, setLastToolCallId] = useState<string | null>(null);
  const [lastToolName, setLastToolName] = useState<string | null>(null);
  const [lastToolParameters, setLastToolParameters] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [lastToolCallTimestamp, setLastToolCallTimestamp] =
    useState<Date | null>(null);
  const [savedRequests, setSavedRequests] = useState<SavedRequest[]>([]);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null);
  const [dialogDefaults, setDialogDefaults] = useState<{
    title: string;
    description?: string;
  }>({ title: "" });

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

  useEffect(() => {
    if (!serverConfig || !serverName) {
      setTools({});
      setSelectedTool("");
      setFormFields([]);
      setResult(null);
      setStructuredResult(null);
      setShowStructured(false);
      setValidationErrors(undefined);
      setUnstructuredValidationResult("not_applicable");
      setError("");
      setActiveElicitation(null);
      return;
    }
    void fetchTools();
  }, [serverConfig, serverName]);

  useEffect(() => {
    if (!serverConfig) return;
    setSavedRequests(listSavedRequests(serverKey));
  }, [serverConfig, serverKey]);

  useEffect(() => {
    if (selectedTool && tools[selectedTool]) {
      setFormFields(
        generateFormFieldsFromSchema(tools[selectedTool].inputSchema),
      );
    }
  }, [selectedTool, tools]);

  const fetchTools = async () => {
    if (!serverName) {
      logger.warn("Cannot fetch tools: no serverId available");
      return;
    }

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

    try {
      const data = await listTools(serverName);
      const toolArray = data.tools ?? [];
      const dictionary = Object.fromEntries(
        toolArray.map((tool) => [tool.name, tool]),
      );
      setTools(dictionary);
      logger.info("Tools fetched", {
        serverId: serverName,
        toolCount: toolArray.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.error("Failed to fetch tools", { error: message });
      setError(
        "Network error fetching tools. Make sure you selected the correct server and the server is running.",
      );
    } finally {
      setFetchingTools(false);
    }
  };

  const updateFieldValue = (fieldName: string, value: unknown) => {
    setFormFields((prev) =>
      prev.map((field) =>
        field.name === fieldName ? { ...field, value } : field,
      ),
    );
  };

  const applyParametersToFields = (params: Record<string, unknown>) => {
    setFormFields((prev) => applyParamsToFields(prev, params));
  };

  const buildParameters = (): Record<string, unknown> =>
    buildParametersFromFields(formFields, (msg, ctx) => logger.warn(msg, ctx));

  const getToolMeta = (
    toolName: string | null,
  ): Record<string, any> | undefined => {
    return toolName ? tools[toolName]?._meta : undefined;
  };

  const handleExecutionResponse = (
    response: ToolExecutionResponse,
    toolName: string,
    startedAt: number,
  ) => {
    if ("result" in response && response.status === "completed") {
      setActiveElicitation(null);
      const callResult = response.result;
      setResult(callResult);

      const rawResult = callResult as unknown as Record<string, unknown>;
      if (rawResult?.structuredContent) {
        setStructuredResult(
          rawResult.structuredContent as Record<string, unknown>,
        );
        // Check for OpenAI component using tool metadata from definition
        const toolMeta = getToolMeta(toolName);
        const hasOpenAIComponent = toolMeta?.["openai/outputTemplate"];
        setShowStructured(!hasOpenAIComponent);
      } else {
        setStructuredResult(null);
        setShowStructured(false);
      }

      const currentTool = tools[toolName];
      if (currentTool?.outputSchema) {
        const validationReport = validateToolOutput(
          rawResult,
          currentTool.outputSchema,
        );
        setValidationErrors(validationReport.structuredErrors);
        setUnstructuredValidationResult(validationReport.unstructuredStatus);
        if (validationReport.structuredErrors) {
          logger.warn("Schema validation failed", {
            errors: validationReport.structuredErrors,
          });
        }
      } else {
        setValidationErrors(undefined);
        setUnstructuredValidationResult("not_applicable");
      }

      logger.info("Tool execution completed", {
        toolName,
        duration: Date.now() - startedAt,
      });
      return;
    }

    if ("status" in response && response.status === "elicitation_required") {
      setActiveElicitation({
        executionId: response.executionId,
        requestId: response.requestId,
        request: response.request,
        timestamp: response.timestamp,
      });
      return;
    }

    if ("error" in response && response.error) {
      setError(response.error);
    }
  };

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
    const toolCallId = `tool-${executionStartTime}`;
    const toolCallTimestamp = new Date();

    try {
      const params = buildParameters();
      setLastToolCallId(toolCallId);
      setLastToolName(selectedTool);
      setLastToolParameters(params);
      setLastToolCallTimestamp(toolCallTimestamp);

      const response = await executeToolApi(serverName, selectedTool, params);
      handleExecutionResponse(response, selectedTool, executionStartTime);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.error("Tool execution network error", {
        toolName: selectedTool,
        error: message,
      });
      setError("Error executing tool");
    } finally {
      setLoading(false);
    }
  };

  const handleElicitationResponse = async (
    action: "accept" | "decline" | "cancel",
    parameters?: Record<string, unknown>,
  ) => {
    if (!activeElicitation) {
      logger.warn("Cannot handle elicitation response: no active request");
      return;
    }

    setElicitationLoading(true);
    try {
      const payload: ElicitResult =
        action === "accept"
          ? { action: "accept", content: parameters ?? {} }
          : { action };
      const response = await respondToElicitationApi(
        activeElicitation.requestId,
        payload,
      );
      handleExecutionResponse(response, selectedTool, Date.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.error("Error responding to elicitation", {
        requestId: activeElicitation.requestId,
        action,
        error: message,
      });
      setError("Error responding to elicitation request");
    } finally {
      setElicitationLoading(false);
    }
  };

  const handleSaveCurrent = () => {
    if (!selectedTool) return;
    setEditingRequestId(null);
    setDialogDefaults({ title: selectedTool, description: "" });
    setIsSaveDialogOpen(true);
  };

  const handleLoadRequest = (req: SavedRequest) => {
    setSelectedTool(req.toolName);
    setTimeout(() => applyParametersToFields(req.parameters), 50);
  };

  const handleDeleteRequest = (id: string) => {
    deleteRequest(serverKey, id);
    setSavedRequests(listSavedRequests(serverKey));
  };

  const handleDuplicateRequest = (req: SavedRequest) => {
    const duplicated = duplicateRequest(serverKey, req.id);
    setSavedRequests(listSavedRequests(serverKey));
    if (duplicated?.id) {
      setHighlightedRequestId(duplicated.id);
      setTimeout(() => setHighlightedRequestId(null), 2000);
    }
  };

  const handleRenameRequest = (req: SavedRequest) => {
    setEditingRequestId(req.id);
    setDialogDefaults({ title: req.title, description: req.description });
    setIsSaveDialogOpen(true);
  };

  const toolNames = Object.keys(tools);
  const filteredToolNames = searchQuery.trim()
    ? toolNames.filter((name) => {
        const tool = tools[name];
        const haystack = `${name} ${tool?.description ?? ""}`.toLowerCase();
        return haystack.includes(searchQuery.trim().toLowerCase());
      })
    : toolNames;

  const filteredSavedRequests = searchQuery.trim()
    ? savedRequests.filter((tool) => {
        const haystack =
          `${tool.title} ${tool.description ?? ""}`.toLowerCase();
        return haystack.includes(searchQuery.trim().toLowerCase());
      })
    : savedRequests;

  const dialogElicitation: DialogElicitation | null = activeElicitation
    ? {
        requestId: activeElicitation.requestId,
        message: activeElicitation.request.message,
        schema: activeElicitation.request.requestedSchema as
          | Record<string, unknown>
          | undefined,
        timestamp: activeElicitation.timestamp,
      }
    : null;

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
        <ResizablePanel defaultSize={70} minSize={30}>
          <ResizablePanelGroup direction="horizontal" className="h-full">
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
            <ResizableHandle withHandle />
            {selectedTool ? (
              <ParametersPanel
                selectedTool={selectedTool}
                toolDescription={tools[selectedTool]?.description}
                formFields={formFields}
                loading={loading}
                waitingOnElicitation={!!activeElicitation}
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
            )}
          </ResizablePanelGroup>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={40} minSize={15} maxSize={85}>
          <ResultsPanel
            error={error}
            showStructured={showStructured}
            onToggleStructured={setShowStructured}
            structuredResult={structuredResult}
            result={result}
            validationErrors={validationErrors}
            unstructuredValidationResult={unstructuredValidationResult}
            serverId={serverName}
            toolCallId={lastToolCallId ?? undefined}
            toolName={lastToolName ?? undefined}
            toolParameters={lastToolParameters ?? undefined}
            toolCallTimestamp={lastToolCallTimestamp ?? undefined}
            toolMeta={getToolMeta(lastToolName)}
            onExecuteFromUI={async (name, params) => {
              if (!serverName) return;
              await executeToolApi(serverName, name, params || {});
            }}
            onHandleIntent={async (intent, params) => {
              if (!serverName) return;
              await executeToolApi(serverName, "handleIntent", {
                intent,
                params: params || {},
              });
            }}
            onSendFollowup={(message) => {
              logger.info("OpenAI component requested follow-up", { message });
            }}
          />
        </ResizablePanel>
      </ResizablePanelGroup>

      <ElicitationDialog
        elicitationRequest={dialogElicitation}
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
          setActiveTab("saved");
          if (newRequest?.id) {
            setHighlightedRequestId(newRequest.id);
            setTimeout(() => setHighlightedRequestId(null), 2000);
          }
        }}
      />
    </div>
  );
}
