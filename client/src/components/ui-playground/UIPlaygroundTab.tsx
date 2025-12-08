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
import { PlaygroundLeft } from "./PlaygroundLeft";
import { PlaygroundMain } from "./PlaygroundMain";
import SaveRequestDialog from "../tools/SaveRequestDialog";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { listTools } from "@/lib/apis/mcp-tools-api";
import { generateFormFieldsFromSchema } from "@/lib/tool-form";
import type { MCPServerConfig } from "@/sdk";

// Custom hooks
import { useServerKey, useSavedRequests, useToolExecution } from "./hooks";

// Constants
import { PANEL_SIZES } from "./constants";

interface UIPlaygroundTabProps {
  serverConfig?: MCPServerConfig;
  serverName?: string;
}

export function UIPlaygroundTab({
  serverConfig,
  serverName,
}: UIPlaygroundTabProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  // Compute server key for saved requests storage
  const serverKey = useServerKey(serverConfig);

  // Get store state and actions
  const {
    selectedTool,
    tools,
    formFields,
    isExecuting,
    deviceType,
    displayMode,
    isSidebarVisible,
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
    toggleSidebar,
    reset,
  } = useUIPlaygroundStore();

  const [isLoggerVisible, setIsLoggerVisible] = useState(true);

  // Sync theme from preferences to globals
  useEffect(() => {
    updateGlobal("theme", themeMode);
  }, [themeMode, updateGlobal]);

  // Tools metadata for filtering OpenAI apps
  const [toolsMetadata, setToolsMetadata] = useState<
    Record<string, Record<string, unknown>>
  >({});

  // Tool execution hook
  const { pendingExecution, clearPendingExecution, executeTool } =
    useToolExecution({
      serverName,
      selectedTool,
      formFields,
      setIsExecuting,
      setExecutionError,
      setToolOutput,
      setToolResponseMetadata,
    });

  // Saved requests hook
  const savedRequestsHook = useSavedRequests({
    serverKey,
    tools,
    formFields,
    selectedTool,
    setSelectedTool,
    setFormFields,
  });

  // Search state
  const [searchQuery, setSearchQuery] = useState("");

  // Compute tool names - show ChatGPT/MCP apps (OpenAI SDK or MCP Apps metadata)
  const toolNames = useMemo(() => {
    return Object.keys(tools).filter((name) => {
      const meta = toolsMetadata[name];
      return (
        meta?.["openai/outputTemplate"] != null ||
        meta?.["ui/resourceUri"] != null
      );
    });
  }, [tools, toolsMetadata]);

  // Filter tool names by search query
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
  const filteredSavedRequests = useMemo(
    () => savedRequestsHook.getFilteredRequests(searchQuery),
    [savedRequestsHook, searchQuery],
  );

  // Fetch tools when server changes
  const fetchTools = useCallback(async () => {
    if (!serverName) return;

    reset();
    setToolsMetadata({});
    try {
      const data = await listTools(serverName);
      const toolArray = data.tools ?? [];
      const dictionary = Object.fromEntries(
        toolArray.map((tool: Tool) => [tool.name, tool]),
      );
      setTools(dictionary);
      setToolsMetadata(data.toolsMetadata ?? {});
    } catch (err) {
      console.error("Failed to fetch tools:", err);
      setExecutionError(
        err instanceof Error ? err.message : "Failed to fetch tools",
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
      setFormFields(
        generateFormFieldsFromSchema(tools[selectedTool].inputSchema),
      );
    } else {
      setFormFields([]);
    }
  }, [selectedTool, tools, setFormFields]);

  // Get invoking message from tool metadata
  const invokingMessage = useMemo(() => {
    if (!selectedTool) return null;
    const meta = toolsMetadata[selectedTool];
    return (meta?.["openai/toolInvocation/invoking"] as string) ?? null;
  }, [selectedTool, toolsMetadata]);

  // Compute center panel default size based on sidebar/inspector visibility
  const centerPanelDefaultSize = isSidebarVisible
    ? PANEL_SIZES.CENTER.DEFAULT_WITH_PANELS
    : PANEL_SIZES.CENTER.DEFAULT_WITHOUT_PANELS;

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
            <ResizablePanel
              id="playground-left"
              order={1}
              defaultSize={PANEL_SIZES.LEFT.DEFAULT}
              minSize={PANEL_SIZES.LEFT.MIN}
              maxSize={PANEL_SIZES.LEFT.MAX}
            >
              <PlaygroundLeft
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
                onSave={savedRequestsHook.openSaveDialog}
                savedRequests={savedRequestsHook.savedRequests}
                filteredSavedRequests={filteredSavedRequests}
                highlightedRequestId={savedRequestsHook.highlightedRequestId}
                onLoadRequest={savedRequestsHook.handleLoadRequest}
                onRenameRequest={savedRequestsHook.handleRenameRequest}
                onDuplicateRequest={savedRequestsHook.handleDuplicateRequest}
                onDeleteRequest={savedRequestsHook.handleDeleteRequest}
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
        <ResizablePanel
          id="playground-center"
          order={2}
          defaultSize={centerPanelDefaultSize}
          minSize={PANEL_SIZES.CENTER.MIN}
        >
          <PlaygroundMain
            serverName={serverName || ""}
            isExecuting={isExecuting}
            executingToolName={selectedTool}
            invokingMessage={invokingMessage}
            pendingExecution={pendingExecution}
            onExecutionInjected={clearPendingExecution}
            onWidgetStateChange={(_toolCallId, state) => setWidgetState(state)}
            deviceType={deviceType}
            onDeviceTypeChange={setDeviceType}
            displayMode={displayMode}
            onDisplayModeChange={setDisplayMode}
          />
        </ResizablePanel>
      </ResizablePanelGroup>

      <SaveRequestDialog
        open={savedRequestsHook.saveDialogState.isOpen}
        defaultTitle={savedRequestsHook.saveDialogState.defaults.title}
        defaultDescription={
          savedRequestsHook.saveDialogState.defaults.description
        }
        onCancel={savedRequestsHook.closeSaveDialog}
        onSave={savedRequestsHook.handleSaveDialogSubmit}
      />
    </div>
  );
}
