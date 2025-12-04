/**
 * UIPlaygroundTab
 *
 * Main orchestrator component for the UI Playground tab.
 * Combines the determinism of ToolsTab with playground aesthetics
 * for testing ChatGPT Apps (OpenAI Apps SDK widgets).
 */

import { useEffect, useCallback, useMemo, useState } from "react";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Wrench } from "lucide-react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../ui/resizable";
import { EmptyState } from "../ui/empty-state";
import { PlaygroundToolsSidebar } from "./PlaygroundToolsSidebar";
import { PlaygroundEmulator } from "./PlaygroundEmulator";
import { PlaygroundInspector } from "./PlaygroundInspector";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { listTools, executeToolApi } from "@/lib/apis/mcp-tools-api";
import {
  generateFormFieldsFromSchema,
  buildParametersFromFields,
} from "@/lib/tool-form";
import type { MCPServerConfig } from "@/sdk";

interface UIPlaygroundTabProps {
  serverConfig?: MCPServerConfig;
  serverName?: string;
}

/**
 * Check if a tool is a ChatGPT App tool (returns widget UI)
 */
function isChatGPTAppTool(
  tool: Tool | undefined,
  toolOutput: unknown
): boolean {
  if (!tool) return false;

  // Check for outputTemplate in tool definition metadata
  const hasOutputTemplate = !!tool._meta?.["openai/outputTemplate"];

  // Or check for structuredContent with HTML resource in output
  if (
    toolOutput &&
    typeof toolOutput === "object" &&
    toolOutput !== null &&
    "structuredContent" in toolOutput
  ) {
    const content = (toolOutput as { structuredContent?: unknown }).structuredContent;
    if (content && typeof content === "object" && content !== null) {
      const { resourceUri, mimeType } = content as {
        resourceUri?: string;
        mimeType?: string;
      };
      if (resourceUri && mimeType === "text/html+skybridge") {
        return true;
      }
    }
  }

  return hasOutputTemplate;
}

export function UIPlaygroundTab({
  serverConfig,
  serverName,
}: UIPlaygroundTabProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);

  // Get store state and actions
  const {
    selectedTool,
    tools,
    formFields,
    isExecuting,
    toolOutput,
    toolResponseMetadata,
    executionError,
    widgetUrl,
    widgetState,
    isWidgetTool,
    csp,
    cspViolations,
    deviceType,
    displayMode,
    globals,
    lastToolCallId,
    setTools,
    setSelectedTool,
    setFormFields,
    updateFormField,
    updateFormFieldIsSet,
    setIsExecuting,
    setToolOutput,
    setToolResponseMetadata,
    setExecutionError,
    setWidgetUrl,
    setWidgetState,
    setIsWidgetTool,
    setDeviceType,
    setDisplayMode,
    updateGlobal,
    setCsp,
    addCspViolation,
    setLastToolCallId,
    followUpMessages,
    addFollowUpMessage,
    clearFollowUpMessages,
    reset,
  } = useUIPlaygroundStore();

  // Sync theme from preferences to globals
  useEffect(() => {
    updateGlobal("theme", themeMode);
  }, [themeMode, updateGlobal]);

  // Compute tool names and filtering
  const toolNames = useMemo(() => Object.keys(tools), [tools]);
  const [searchQuery, setSearchQuery] = useState("");
  const [hasExecuted, setHasExecuted] = useState(false);
  const filteredToolNames = useMemo(() => {
    if (!searchQuery.trim()) return toolNames;
    const query = searchQuery.trim().toLowerCase();
    return toolNames.filter((name) => {
      const tool = tools[name];
      const haystack = `${name} ${tool?.description ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [toolNames, tools, searchQuery]);

  // Extract invocation messages from selected tool metadata
  const invocationMessages = useMemo(() => {
    if (!selectedTool || !tools[selectedTool]) return null;
    const meta = tools[selectedTool]._meta as Record<string, unknown> | undefined;
    if (!meta) return null;

    const invoking = meta["openai/toolInvocation/invoking"] as string | undefined;
    const invoked = meta["openai/toolInvocation/invoked"] as string | undefined;

    if (!invoking && !invoked) return null;
    return { invoking, invoked };
  }, [selectedTool, tools]);

  // Fetch tools when server changes
  const fetchTools = useCallback(async () => {
    if (!serverName) return;

    reset();
    try {
      const data = await listTools(serverName);
      const toolArray = data.tools ?? [];
      const dictionary = Object.fromEntries(
        toolArray.map((tool: Tool) => [tool.name, tool])
      );
      setTools(dictionary);
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
    // Reset hasExecuted when tool changes
    setHasExecuted(false);
  }, [selectedTool, tools, setFormFields]);

  // Execute tool
  const executeTool = useCallback(async () => {
    if (!selectedTool || !serverName) return;

    setIsExecuting(true);
    setHasExecuted(true);
    setExecutionError(null);
    setToolOutput(null);
    setToolResponseMetadata(null);
    setWidgetUrl(null);
    setWidgetState(null);
    setIsWidgetTool(false);
    setCsp(null);

    const toolCallId = `playground-${Date.now()}`;
    setLastToolCallId(toolCallId);

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
      setToolOutput(result);

      // Extract metadata
      const rawResult = result as unknown as Record<string, unknown>;
      const meta = (rawResult?._meta || rawResult?.meta) as Record<string, unknown> | undefined;
      setToolResponseMetadata(meta || null);

      // Check if this is a ChatGPT App tool
      const tool = tools[selectedTool];
      const isWidget = isChatGPTAppTool(tool, result);
      setIsWidgetTool(isWidget);

      // If it's a widget tool, prepare the widget
      if (isWidget) {
        const outputTemplate = tool?._meta?.["openai/outputTemplate"] as string | undefined;

        // Extract CSP from metadata
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

        // Extract structured content
        let structuredContent = null;
        if (rawResult?.structuredContent) {
          structuredContent = rawResult.structuredContent;
        }

        // Store widget data and get URL
        try {
          const storeResponse = await fetch("/api/mcp/openai/widget/store", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              serverId: serverName,
              uri: outputTemplate,
              toolInput: params,
              toolOutput: structuredContent || result,
              toolResponseMetadata: meta,
              toolId: toolCallId,
              toolName: selectedTool,
              theme: globals.theme,
              locale: globals.locale,
              deviceType: globals.deviceType,
              userLocation: globals.userLocation,
            }),
          });

          if (storeResponse.ok) {
            setWidgetUrl(`/api/mcp/openai/widget/${toolCallId}`);
          } else {
            throw new Error("Failed to store widget data");
          }
        } catch (err) {
          console.error("Error storing widget data:", err);
          setExecutionError(
            err instanceof Error ? err.message : "Failed to prepare widget"
          );
        }
      }
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
    tools,
    globals,
    setIsExecuting,
    setExecutionError,
    setToolOutput,
    setToolResponseMetadata,
    setWidgetUrl,
    setWidgetState,
    setIsWidgetTool,
    setCsp,
    setLastToolCallId,
  ]);

  // Handle callTool from widget
  const handleCallTool = useCallback(
    async (toolName: string, params: Record<string, unknown>) => {
      if (!serverName) throw new Error("No server selected");
      const response = await executeToolApi(serverName, toolName, params);
      if ("error" in response) throw new Error(response.error);
      if (response.status === "elicitation_required") {
        throw new Error("Nested elicitation not supported");
      }
      return response.result;
    },
    [serverName]
  );

  // Handle follow-up message from widget
  const handleSendFollowUp = useCallback((message: string) => {
    console.log("[UIPlayground] Widget requested follow-up:", message);
    addFollowUpMessage(message);
  }, [addFollowUpMessage]);

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
    <div className="h-full flex flex-col">
      <ResizablePanelGroup direction="horizontal" className="flex-1">
        {/* Left Panel - Tools Sidebar */}
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
          />
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Center Panel - Emulator */}
        <ResizablePanel defaultSize={45} minSize={30}>
          <PlaygroundEmulator
            serverId={serverName || ""}
            serverName={serverName || null}
            toolCallId={lastToolCallId}
            toolName={selectedTool}
            widgetUrl={widgetUrl}
            isWidgetTool={isWidgetTool}
            isExecuting={isExecuting}
            executionError={executionError}
            hasExecuted={hasExecuted}
            invocationMessages={invocationMessages}
            deviceType={deviceType}
            displayMode={displayMode}
            globals={globals}
            followUpMessages={followUpMessages}
            onDeviceTypeChange={setDeviceType}
            onDisplayModeChange={setDisplayMode}
            onWidgetStateChange={setWidgetState}
            onCspViolation={addCspViolation}
            onCallTool={handleCallTool}
            onSendFollowUp={handleSendFollowUp}
            onClearFollowUpMessages={clearFollowUpMessages}
          />
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Right Panel - Inspector */}
        <ResizablePanel defaultSize={30} minSize={20} maxSize={50}>
          <PlaygroundInspector
            toolOutput={toolOutput}
            toolResponseMetadata={toolResponseMetadata}
            widgetState={widgetState}
            globals={globals}
            csp={csp}
            cspViolations={cspViolations}
            widgetId={lastToolCallId}
            onUpdateGlobal={updateGlobal}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
