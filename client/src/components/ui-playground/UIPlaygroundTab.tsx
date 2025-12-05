/**
 * UIPlaygroundTab
 *
 * Main orchestrator component for the UI Playground tab.
 * Combines deterministic tool execution with ChatTabV2-style chat,
 * allowing users to execute tools and then chat about the results.
 */

import { useEffect, useCallback, useMemo, useState } from "react";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Wrench } from "lucide-react";
import {
  ResizablePanel,
  ResizablePanelGroup,
  ResizableHandle,
} from "../ui/resizable";
import { EmptyState } from "../ui/empty-state";
import { CollapsedPanelStrip } from "../ui/collapsed-panel-strip";
import { PlaygroundToolsSidebar } from "./PlaygroundToolsSidebar";
import { PlaygroundThread } from "./PlaygroundThread";
import { PlaygroundInspector } from "./PlaygroundInspector";
import SaveRequestDialog from "../tools/SaveRequestDialog";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { listTools, executeToolApi, type ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";
import {
  generateFormFieldsFromSchema,
  buildParametersFromFields,
  applyParametersToFields,
} from "@/lib/tool-form";
import {
  listSavedRequests,
  saveRequest,
  deleteRequest,
  duplicateRequest,
  updateRequestMeta,
} from "@/lib/request-storage";
import type { SavedRequest } from "@/lib/types/request-types";
import type { MCPServerConfig } from "@/sdk";

// Pending execution to be injected into chat
interface PendingExecution {
  toolName: string;
  params: Record<string, unknown>;
  result: unknown;
  toolMeta: Record<string, unknown> | undefined;
}

interface UIPlaygroundTabProps {
  serverConfig?: MCPServerConfig;
  serverName?: string;
}

export function UIPlaygroundTab({
  serverConfig,
  serverName,
}: UIPlaygroundTabProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);

  // Pending execution to inject into chat thread
  const [pendingExecution, setPendingExecution] = useState<PendingExecution | null>(null);

  // Saved requests state
  const [savedRequests, setSavedRequests] = useState<SavedRequest[]>([]);
  const [highlightedRequestId, setHighlightedRequestId] = useState<string | null>(null);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null);
  const [dialogDefaults, setDialogDefaults] = useState<{ title: string; description?: string }>({ title: "" });

  // Compute server key for saved requests storage
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

  // Get store state and actions
  const {
    selectedTool,
    tools,
    formFields,
    isExecuting,
    deviceType,
    displayMode,
    globals,
    isSidebarVisible,
    isInspectorVisible,
    setTools,
    setSelectedTool,
    setFormFields,
    updateFormField,
    updateFormFieldIsSet,
    setIsExecuting,
    setToolOutput,
    setToolResponseMetadata,
    setExecutionError,
    setWidgetState,
    setDeviceType,
    setDisplayMode,
    updateGlobal,
    setCsp,
    toggleSidebar,
    toggleInspector,
    reset,
  } = useUIPlaygroundStore();

  // Sync theme from preferences to globals
  useEffect(() => {
    updateGlobal("theme", themeMode);
  }, [themeMode, updateGlobal]);

  // Tools metadata for filtering OpenAI apps
  const [toolsMetadata, setToolsMetadata] = useState<Record<string, Record<string, unknown>>>({});

  // Compute tool names - only show OpenAI apps (tools with openai/outputTemplate metadata)
  const toolNames = useMemo(() => {
    return Object.keys(tools).filter(
      (name) => toolsMetadata[name]?.["openai/outputTemplate"] != null
    );
  }, [tools, toolsMetadata]);
  const [searchQuery, setSearchQuery] = useState("");
  const filteredToolNames = useMemo(() => {
    if (!searchQuery.trim()) return toolNames;
    const query = searchQuery.trim().toLowerCase();
    return toolNames.filter((name) => {
      const tool = tools[name];
      const haystack = `${name} ${tool?.description ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [toolNames, tools, searchQuery]);

  // Filter saved requests by search query
  const filteredSavedRequests = useMemo(() => {
    if (!searchQuery.trim()) return savedRequests;
    const query = searchQuery.trim().toLowerCase();
    return savedRequests.filter((req) => {
      const haystack = `${req.title} ${req.description ?? ""} ${req.toolName}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [savedRequests, searchQuery]);

  // Load saved requests when server changes
  useEffect(() => {
    if (serverConfig) {
      setSavedRequests(listSavedRequests(serverKey));
    }
  }, [serverConfig, serverKey]);

  // Fetch tools when server changes
  const fetchTools = useCallback(async () => {
    if (!serverName) return;

    reset();
    setToolsMetadata({});
    try {
      const data = await listTools(serverName);
      const toolArray = data.tools ?? [];
      const dictionary = Object.fromEntries(
        toolArray.map((tool: Tool) => [tool.name, tool])
      );
      setTools(dictionary);
      setToolsMetadata(data.toolsMetadata ?? {});
    } catch (err) {
      console.error("Failed to fetch tools:", err);
      setExecutionError(
        err instanceof Error ? err.message : "Failed to fetch tools"
      );
    }
  }, [serverName, reset, setTools, setExecutionError]);

  useEffect(() => {
    if (serverConfig && serverName) {
      fetchTools();
    } else {
      reset();
    }
  }, [serverConfig, serverName, fetchTools, reset]);

  // Update form fields when tool is selected
  useEffect(() => {
    if (selectedTool && tools[selectedTool]) {
      setFormFields(generateFormFieldsFromSchema(tools[selectedTool].inputSchema));
    } else {
      setFormFields([]);
    }
  }, [selectedTool, tools, setFormFields]);

  // Execute tool and inject into chat thread
  const executeTool = useCallback(async () => {
    if (!selectedTool || !serverName) return;

    setIsExecuting(true);
    setExecutionError(null);

    try {
      const params = buildParametersFromFields(formFields);
      const response = await executeToolApi(serverName, selectedTool, params);

      if ("error" in response) {
        setExecutionError(response.error);
        setIsExecuting(false);
        return;
      }

      if (response.status === "elicitation_required") {
        setExecutionError(
          "Tool requires elicitation, which is not supported in the UI Playground yet."
        );
        setIsExecuting(false);
        return;
      }

      const result = response.result;

      // Store raw output for inspector
      setToolOutput(result);

      // Extract metadata for inspector
      const rawResult = result as unknown as Record<string, unknown>;
      const meta = (rawResult?._meta || rawResult?.meta) as Record<string, unknown> | undefined;
      setToolResponseMetadata(meta || null);

      // Extract CSP for inspector
      const widgetCsp = meta?.["openai/widgetCSP"] as {
        connectDomains?: string[];
        resourceDomains?: string[];
      } | undefined;
      if (widgetCsp) {
        setCsp({
          connectDomains: widgetCsp.connectDomains || [],
          resourceDomains: widgetCsp.resourceDomains || [],
        });
      }

      // Set pending execution for chat thread to inject
      setPendingExecution({
        toolName: selectedTool,
        params,
        result,
        toolMeta: meta,
      });
    } catch (err) {
      console.error("Tool execution error:", err);
      setExecutionError(
        err instanceof Error ? err.message : "Tool execution failed"
      );
    } finally {
      setIsExecuting(false);
    }
  }, [
    selectedTool,
    serverName,
    formFields,
    setIsExecuting,
    setExecutionError,
    setToolOutput,
    setToolResponseMetadata,
    setCsp,
  ]);

  // Keyboard shortcut for execute
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && selectedTool && !isExecuting) {
        e.preventDefault();
        executeTool();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedTool, isExecuting, executeTool]);

  // Saved request handlers
  const handleSaveCurrent = useCallback(() => {
    if (!selectedTool) return;
    setEditingRequestId(null);
    setDialogDefaults({ title: selectedTool, description: "" });
    setIsSaveDialogOpen(true);
  }, [selectedTool]);

  const handleLoadRequest = useCallback((req: SavedRequest) => {
    setSelectedTool(req.toolName);
    // Wait for form fields to be generated, then apply parameters
    setTimeout(() => {
      if (tools[req.toolName]) {
        const fields = generateFormFieldsFromSchema(tools[req.toolName].inputSchema);
        const updatedFields = applyParametersToFields(fields, req.parameters);
        setFormFields(updatedFields);
      }
    }, 50);
  }, [tools, setSelectedTool, setFormFields]);

  const handleDeleteRequest = useCallback((id: string) => {
    deleteRequest(serverKey, id);
    setSavedRequests(listSavedRequests(serverKey));
  }, [serverKey]);

  const handleDuplicateRequest = useCallback((req: SavedRequest) => {
    const duplicated = duplicateRequest(serverKey, req.id);
    setSavedRequests(listSavedRequests(serverKey));
    if (duplicated?.id) {
      setHighlightedRequestId(duplicated.id);
      setTimeout(() => setHighlightedRequestId(null), 2000);
    }
  }, [serverKey]);

  const handleRenameRequest = useCallback((req: SavedRequest) => {
    setEditingRequestId(req.id);
    setDialogDefaults({ title: req.title, description: req.description });
    setIsSaveDialogOpen(true);
  }, []);

  const handleSaveDialogSubmit = useCallback(({ title, description }: { title: string; description?: string }) => {
    if (editingRequestId) {
      updateRequestMeta(serverKey, editingRequestId, { title, description });
      setSavedRequests(listSavedRequests(serverKey));
      setEditingRequestId(null);
      setIsSaveDialogOpen(false);
      setHighlightedRequestId(editingRequestId);
      setTimeout(() => setHighlightedRequestId(null), 2000);
      return;
    }

    const params = buildParametersFromFields(formFields);
    const newRequest = saveRequest(serverKey, {
      title,
      description,
      toolName: selectedTool!,
      parameters: params,
    });
    setSavedRequests(listSavedRequests(serverKey));
    setIsSaveDialogOpen(false);
    if (newRequest?.id) {
      setHighlightedRequestId(newRequest.id);
      setTimeout(() => setHighlightedRequestId(null), 2000);
    }
  }, [editingRequestId, serverKey, formFields, selectedTool]);

  // No server selected
  if (!serverConfig) {
    return (
      <EmptyState
        icon={Wrench}
        title="No Server Selected"
        description="Connect to an MCP server to test ChatGPT Apps in the UI Playground."
      />
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <ResizablePanelGroup direction="horizontal" className="flex-1 min-h-0">
        {/* Left Panel - Tools Sidebar */}
        {isSidebarVisible ? (
          <>
            <ResizablePanel defaultSize={25} minSize={15} maxSize={40}>
              <PlaygroundToolsSidebar
              tools={tools}
              toolNames={toolNames}
              filteredToolNames={filteredToolNames}
              selectedToolName={selectedTool}
              fetchingTools={false}
              searchQuery={searchQuery}
              onSearchQueryChange={setSearchQuery}
              onRefresh={fetchTools}
              onSelectTool={setSelectedTool}
              formFields={formFields}
              onFieldChange={updateFormField}
              onToggleField={updateFormFieldIsSet}
              isExecuting={isExecuting}
              onExecute={executeTool}
              onSave={handleSaveCurrent}
              deviceType={deviceType}
              displayMode={displayMode}
              onDeviceTypeChange={setDeviceType}
              onDisplayModeChange={setDisplayMode}
              globals={globals}
              onUpdateGlobal={updateGlobal}
              savedRequests={savedRequests}
              filteredSavedRequests={filteredSavedRequests}
              highlightedRequestId={highlightedRequestId}
              onLoadRequest={handleLoadRequest}
              onRenameRequest={handleRenameRequest}
              onDuplicateRequest={handleDuplicateRequest}
              onDeleteRequest={handleDeleteRequest}
              onClose={toggleSidebar}
            />
            </ResizablePanel>
            <ResizableHandle withHandle />
          </>
        ) : (
          <CollapsedPanelStrip
            side="left"
            onOpen={toggleSidebar}
            tooltipText="Show tools sidebar"
          />
        )}

        {/* Center Panel - Chat Thread */}
        <ResizablePanel defaultSize={isSidebarVisible && isInspectorVisible ? 45 : 70} minSize={30}>
          <PlaygroundThread
            serverName={serverName || ""}
            isExecuting={isExecuting}
            executingToolName={selectedTool}
            invokingMessage={
              selectedTool && tools[selectedTool]
                ? (tools[selectedTool] as any)._meta?.[
                    "openai/toolInvocation/invoking"
                  ]
                : null
            }
            pendingExecution={pendingExecution}
            onExecutionInjected={() => setPendingExecution(null)}
            onWidgetStateChange={(_toolCallId, state) => setWidgetState(state)}
            deviceType={deviceType}
            displayMode={displayMode}
          />
        </ResizablePanel>

        {/* Right Panel - Inspector */}
        {isInspectorVisible ? (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={30} minSize={20} maxSize={50}>
              <PlaygroundInspector onClose={toggleInspector} />
            </ResizablePanel>
          </>
        ) : (
          <CollapsedPanelStrip
            side="right"
            onOpen={toggleInspector}
            tooltipText="Show inspector panel"
          />
        )}
      </ResizablePanelGroup>

      <SaveRequestDialog
        open={isSaveDialogOpen}
        defaultTitle={dialogDefaults.title}
        defaultDescription={dialogDefaults.description}
        onCancel={() => setIsSaveDialogOpen(false)}
        onSave={handleSaveDialogSubmit}
      />
    </div>
  );
}
