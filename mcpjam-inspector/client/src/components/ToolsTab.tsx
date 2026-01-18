import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CallToolResult,
  ElicitRequest,
  ElicitResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Wrench } from "lucide-react";
import { ElicitationDialog } from "./ElicitationDialog";
import { EmptyState } from "./ui/empty-state";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./ui/resizable";
import { ParametersPanel } from "./tools/ParametersPanel";
import { ResultsPanel } from "./tools/ResultsPanel";
import { LoggerView } from "./logger-view";
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
import type { SavedRequest } from "@/lib/types/request-types";
import { useLogger } from "@/hooks/use-logger";
import {
  executeToolApi,
  listTools,
  respondToElicitationApi,
  type ToolExecutionResponse,
  type TaskOptions,
} from "@/lib/apis/mcp-tools-api";
import {
  getTaskCapabilities,
  type TaskCapabilities,
} from "@/lib/apis/mcp-tasks-api";
import { trackTask } from "@/lib/task-tracker";
import { validateToolOutput } from "@/lib/schema-utils";
import "react18-json-view/src/style.css";
import { MCPServerConfig } from "@/sdk";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { usePostHog } from "posthog-js/react";

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

function normalizeElicitationContent(
  parameters?: Record<string, unknown>,
): ElicitResult["content"] | undefined {
  if (!parameters) return undefined;
  const content: ElicitResult["content"] = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      content[key] = value;
    } else if (
      Array.isArray(value) &&
      value.every((v): v is string => typeof v === "string")
    ) {
      content[key] = value;
    } else if (value !== undefined) {
      content[key] = JSON.stringify(value);
    }
  }
  return content;
}

interface ToolsTabProps {
  serverConfig?: MCPServerConfig;
  serverName?: string;
}

export function ToolsTab({ serverConfig, serverName }: ToolsTabProps) {
  const logger = useLogger("ToolsTab");
  const posthog = usePostHog();
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
  const [loadingExecuteTool, setLoadingExecuteTool] = useState(false);
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
  const [savedRequests, setSavedRequests] = useState<SavedRequest[]>([]);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null);
  const [dialogDefaults, setDialogDefaults] = useState<{
    title: string;
    description?: string;
  }>({ title: "" });
  const [executeAsTask, setExecuteAsTask] = useState(false);
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);
  // Task capabilities from server (MCP Tasks spec 2025-11-25)
  const [taskCapabilities, setTaskCapabilities] =
    useState<TaskCapabilities | null>(null);
  // TTL for task execution (milliseconds, 0 = no expiration)
  const [taskTtl, setTaskTtl] = useState<number>(0);
  // Infinite scroll state
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
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

  // Check if the selected tool requires task execution
  // Per MCP Tasks spec: execution.taskSupport can be "required", "optional", or "forbidden"
  const selectedToolTaskSupport = useMemo(():
    | "required"
    | "optional"
    | "forbidden" => {
    if (!selectedTool || !tools[selectedTool]) return "forbidden";
    const tool = tools[selectedTool];
    const execution = (tool as any).execution;

    // Check standard spec format: execution.taskSupport
    const taskSupport = execution?.taskSupport;
    if (taskSupport === "required" || taskSupport === "optional") {
      return taskSupport;
    }
    if (taskSupport === "forbidden") {
      return "forbidden";
    }

    const taskMode = execution?.task;
    if (taskMode === "always" || taskMode === "required") return "required";
    if (taskMode === "optional") return "optional";
    if (taskMode === "never" || taskMode === "forbidden") return "forbidden";

    // Per MCP spec: if execution.taskSupport is not present, treat as "forbidden"
    // Clients MUST NOT attempt to invoke the tool as a task
    return "forbidden";
  }, [selectedTool, tools]);

  // Check if server supports task-augmented tool calls (MCP Tasks spec 2025-11-25)
  // Per spec: clients MUST NOT use task augmentation if server doesn't declare capability
  const serverSupportsTaskToolCalls =
    taskCapabilities?.supportsToolCalls ?? false;

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
      setTaskCapabilities(null);
      return;
    }
    void fetchTools();
    // Fetch task capabilities for this server (MCP Tasks spec 2025-11-25)
    void fetchTaskCapabilities();
  }, [serverConfig, serverName]);

  const toolNames = Object.keys(tools);
  const filteredToolNames = searchQuery.trim()
    ? toolNames.filter((name) => {
        const tool = tools[name];
        const haystack = `${name} ${tool?.description ?? ""}`.toLowerCase();
        return haystack.includes(searchQuery.trim().toLowerCase());
      })
    : toolNames;

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    if (!sentinelRef.current) return;
    if (activeTab !== "tools") return; // Only observe when tools tab is active

    const element = sentinelRef.current;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry.isIntersecting) return;
      if (!cursor || fetchingTools) return;

      // Load more tools
      fetchTools();
    });

    observer.observe(element);

    return () => {
      observer.unobserve(element);
      observer.disconnect();
    };
  }, [filteredToolNames.length, activeTab, cursor, activeTab, fetchingTools]);

  // Fetch task capabilities for the server
  const fetchTaskCapabilities = async () => {
    if (!serverName) return;
    try {
      const capabilities = await getTaskCapabilities(serverName);
      setTaskCapabilities(capabilities);
      logger.info("Task capabilities fetched", {
        serverId: serverName,
        supportsToolCalls: capabilities.supportsToolCalls,
        supportsList: capabilities.supportsList,
        supportsCancel: capabilities.supportsCancel,
      });
    } catch (err) {
      // Server may not support tasks - this is fine, just log it
      logger.debug("Could not fetch task capabilities", {
        error: err instanceof Error ? err.message : "Unknown error",
      });
      setTaskCapabilities(null);
    }
  };

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

  useEffect(() => {
    posthog.capture("tools_tab_viewed", {
      location: "tools_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
  }, []);

  const fetchTools = async () => {
    if (!serverName) {
      logger.warn("Cannot fetch tools: no serverId available");
      return;
    }

    setFetchingTools(true);
    setError("");
    setSelectedTool("");
    setFormFields([]);
    setResult(null);
    setStructuredResult(null);
    setShowStructured(false);
    setValidationErrors(undefined);
    setUnstructuredValidationResult("not_applicable");

    try {
      // Call to get all of the tools for server
      const data = await listTools(serverName, undefined, cursor);
      const toolArray = data.tools ?? [];
      const dictionary = Object.fromEntries(
        toolArray.map((tool: Tool) => [tool.name, tool]),
      );
      setTools((prev) => ({ ...prev, ...dictionary }));
      setCursor(data.nextCursor);
      logger.info("Tools fetched", {
        serverId: serverName,
        toolCount: toolArray.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.error("Failed to fetch tools", { error: message });
      setError(message);
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

  const updateFieldIsSet = (fieldName: string, isSet: boolean) => {
    setFormFields((prev) =>
      prev.map((field) =>
        field.name === fieldName ? { ...field, isSet } : field,
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
      } else {
        setStructuredResult(null);
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

    // Handle task creation response (MCP Tasks spec 2025-11-25)
    if ("status" in response && response.status === "task_created") {
      const { task, modelImmediateResponse } = response;
      setCreatedTaskId(task.taskId);

      // Track the task locally so it appears in the Tasks tab
      if (serverName) {
        trackTask({
          taskId: task.taskId,
          serverId: serverName,
          createdAt: task.createdAt,
          toolName,
          primitiveType: "tool",
          primitiveName: toolName,
        });
      }

      logger.info("Background task created", {
        toolName,
        taskId: task.taskId,
        status: task.status,
        ttl: task.ttl,
        pollInterval: task.pollInterval,
        duration: Date.now() - startedAt,
        // Per MCP Tasks spec: optional string for LLM hosts to return to model immediately
        modelImmediateResponse: modelImmediateResponse || undefined,
      });

      // Navigate to Tasks tab to monitor the task
      window.location.hash = "tasks";
      return;
    }

    if ("error" in response && response.error) {
      setError(response.error as string);
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

    setLoadingExecuteTool(true);
    setError("");
    setResult(null);
    setStructuredResult(null);
    setShowStructured(false);
    setValidationErrors(undefined);
    setUnstructuredValidationResult("not_applicable");
    setCreatedTaskId(null);

    const executionStartTime = Date.now();
    const toolCallId = `tool-${executionStartTime}`;

    try {
      const params = buildParameters();
      setLastToolCallId(toolCallId);
      setLastToolName(selectedTool);
      setLastToolParameters(params);

      // Pass task options if executing as background task (MCP Tasks spec 2025-11-25)
      // Use task execution only if: server supports tasks AND (user checked option OR tool requires it)
      // Per spec: clients MUST NOT use task augmentation without server capability
      const shouldUseTask =
        serverSupportsTaskToolCalls &&
        (executeAsTask || selectedToolTaskSupport === "required");
      // Per MCP spec: ttl is optional. Only include if user specified a non-zero value.
      // 0 could be misinterpreted by servers, so we use undefined to let server decide.
      const taskOptions: TaskOptions | undefined = shouldUseTask
        ? { ttl: taskTtl > 0 ? taskTtl : undefined }
        : undefined;

      const response = await executeToolApi(
        serverName,
        selectedTool,
        params,
        taskOptions,
      );
      handleExecutionResponse(response, selectedTool, executionStartTime);
    } catch (err) {
      console.error("executeTool", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.error("Tool execution network error", {
        toolName: selectedTool,
        error: message,
      });
      setError(message);
    } finally {
      setLoadingExecuteTool(false);
    }
  };

  // Handle Enter key to execute tool globally
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check if Enter is pressed (not Shift+Enter)
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        selectedTool &&
        !loadingExecuteTool
      ) {
        // Don't trigger if user is typing in an input, textarea, or contenteditable
        const target = e.target as HTMLElement;
        const tagName = target.tagName;
        const isEditable = target.isContentEditable;

        if (tagName === "INPUT" || tagName === "TEXTAREA" || isEditable) {
          return;
        }

        e.preventDefault();
        executeTool();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedTool, loadingExecuteTool]);

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
      const content = normalizeElicitationContent(parameters);
      const payload: ElicitResult =
        action === "accept" && content
          ? { action: "accept", content }
          : { action };
      const response = await respondToElicitationApi(
        activeElicitation.executionId,
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
      setError(message);
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
        schema: (activeElicitation.request as any).requestedSchema as
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
    <div className="h-full flex flex-col">
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
              displayedToolCount={toolNames.length}
              sentinelRef={sentinelRef}
              loadingMore={fetchingTools}
              cursor={cursor ?? ""}
            />
            <ResizableHandle withHandle />
            {selectedTool ? (
              <ParametersPanel
                selectedTool={selectedTool}
                toolDescription={tools[selectedTool]?.description}
                formFields={formFields}
                onToggleField={updateFieldIsSet}
                loading={loadingExecuteTool}
                waitingOnElicitation={!!activeElicitation}
                onExecute={executeTool}
                onSave={handleSaveCurrent}
                onFieldChange={updateFieldValue}
                // Only show task execution option if server supports tasks and tool allows it
                // Per MCP spec: clients MUST NOT use task augmentation without server capability
                executeAsTask={
                  serverSupportsTaskToolCalls &&
                  selectedToolTaskSupport !== "forbidden"
                    ? executeAsTask
                    : undefined
                }
                onExecuteAsTaskChange={
                  serverSupportsTaskToolCalls &&
                  selectedToolTaskSupport !== "forbidden"
                    ? setExecuteAsTask
                    : undefined
                }
                taskRequired={
                  serverSupportsTaskToolCalls &&
                  selectedToolTaskSupport === "required"
                }
                // MCP Tasks spec 2025-11-25: TTL configuration
                taskTtl={taskTtl}
                onTaskTtlChange={setTaskTtl}
                serverSupportsTaskToolCalls={serverSupportsTaskToolCalls}
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
          <ResizablePanelGroup direction="horizontal" className="h-full">
            <ResizablePanel defaultSize={40} minSize={10}>
              <LoggerView serverIds={serverName ? [serverName] : undefined} />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={60} minSize={30}>
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
                toolMeta={getToolMeta(lastToolName)}
                onExecuteFromUI={async (name, params) => {
                  if (!serverName) return { error: "No server selected" };
                  return await executeToolApi(serverName, name, params || {});
                }}
                onHandleIntent={async (intent, params) => {
                  if (!serverName) return;
                  await executeToolApi(serverName, "handleIntent", {
                    intent,
                    params: params || {},
                  });
                }}
                onSendFollowup={(message) => {
                  logger.info("OpenAI component requested follow-up", {
                    message,
                  });
                }}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
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
