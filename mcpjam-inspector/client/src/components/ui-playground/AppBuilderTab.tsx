/**
 * AppBuilderTab
 *
 * Main orchestrator component for the UI Playground tab.
 * Combines deterministic tool execution with ChatTabV2-style chat,
 * allowing users to execute tools and then chat about the results.
 */

import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
} from "react";
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
import { listTools } from "@/lib/apis/mcp-tools-api";
import { generateFormFieldsFromSchema } from "@/lib/tool-form";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { usePostHog } from "posthog-js/react";

// Custom hooks
import { useServerKey, useSavedRequests, useToolExecution } from "./hooks";

// Constants
import { PANEL_SIZES } from "./constants";
import { UIType, detectUiTypeFromTool } from "@/lib/mcp-ui/mcp-apps-utils";

// Onboarding
import { useOnboarding } from "@/hooks/use-onboarding";
import { WelcomeOverlay } from "@/components/app-builder/WelcomeOverlay";
import { AppBuilderSkeleton } from "@/components/app-builder/AppBuilderSkeleton";
import type { ServerFormData } from "@/shared/types.js";
import type { ServerWithName } from "@/hooks/use-app-state";
import { useSidebar } from "@/components/ui/sidebar";
import { toast } from "sonner";

interface AppBuilderTabProps {
  serverConfig?: MCPServerConfig;
  serverName?: string;
  servers?: Record<string, ServerWithName>;
  isAuthenticated?: boolean;
  isAuthLoading?: boolean;
  onConnect?: (formData: ServerFormData) => void;
  onOnboardingChange?: (isOnboarding: boolean) => void;
}

export function AppBuilderTab({
  serverConfig,
  serverName,
  servers = {},
  isAuthenticated = false,
  isAuthLoading = false,
  onConnect,
  onOnboardingChange,
}: AppBuilderTabProps) {
  const posthog = usePostHog();
  // Compute server key for saved requests storage
  const serverKey = useServerKey(serverConfig);

  // Onboarding state machine
  const onboarding = useOnboarding({
    servers,
    onConnect: onConnect ?? (() => {}),
    isAuthenticated,
    isAuthLoading,
  });

  // Get store state and actions
  const {
    selectedTool,
    tools,
    formFields,
    isExecuting,
    deviceType,
    isSidebarVisible,
    selectedProtocol,
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
    toggleSidebar,
    setSelectedProtocol,
    reset,
    setSidebarVisible,
  } = useUIPlaygroundStore();

  // Hide both sidebars and header during onboarding, restore when done
  const isOnboarding =
    onboarding.isOverlayVisible || onboarding.isGuidedPostConnect;
  const { setOpen: setMcpSidebarOpen } = useSidebar();
  const latestIsOnboardingRef = useRef(isOnboarding);
  useEffect(() => {
    latestIsOnboardingRef.current = isOnboarding;
  }, [isOnboarding]);

  useLayoutEffect(() => {
    onOnboardingChange?.(isOnboarding);
    if (isOnboarding) {
      setSidebarVisible(false);
      setMcpSidebarOpen(false);
    } else {
      // Restore sidebars when onboarding ends
      setSidebarVisible(true);
      setMcpSidebarOpen(true);
    }
  }, [isOnboarding, setSidebarVisible, setMcpSidebarOpen, onOnboardingChange]);

  useLayoutEffect(() => {
    return () => {
      if (!latestIsOnboardingRef.current) {
        return;
      }

      onOnboardingChange?.(false);
      setSidebarVisible(true);
      setMcpSidebarOpen(true);
    };
  }, [onOnboardingChange, setSidebarVisible, setMcpSidebarOpen]);

  useEffect(() => {
    if (!isOnboarding) {
      return;
    }

    // Some onboarding toasts, including connection success, are emitted during
    // phase transitions after onboarding has already started.
    toast.dismiss();
    const timer = setTimeout(() => toast.dismiss(), 300);
    return () => clearTimeout(timer);
  }, [isOnboarding, onboarding.phase]);

  // Log when App Builder tab is viewed
  useEffect(() => {
    posthog.capture("app_builder_tab_viewed", {
      location: "app_builder_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
  }, []);

  // Loading state for tool fetching
  const [fetchingTools, setFetchingTools] = useState(false);

  // Tools metadata used for deterministic injection and invocation messaging
  const [toolsMetadata, setToolsMetadata] = useState<
    Record<string, Record<string, unknown>>
  >({});

  // Tool execution hook
  const { pendingExecution, clearPendingExecution, executeTool } =
    useToolExecution({
      serverName,
      selectedTool,
      toolsMetadata,
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

  // Fetch tools when server changes
  const fetchTools = useCallback(async () => {
    if (!serverName) return;

    reset();
    setToolsMetadata({});
    setFetchingTools(true);
    try {
      const data = await listTools({ serverId: serverName });
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
    } finally {
      setFetchingTools(false);
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

  // Detect app protocol - from selected tool OR from server's available tools
  useEffect(() => {
    // If a specific tool is selected, detect its protocol
    if (selectedTool) {
      const tool = tools[selectedTool];
      const uiType = detectUiTypeFromTool(tool);
      if (uiType === UIType.OPENAI_SDK_AND_MCP_APPS) {
        // Tool supports both protocols - only set default if no stored preference
        const validProtocols = [UIType.MCP_APPS, UIType.OPENAI_SDK];
        if (!selectedProtocol || !validProtocols.includes(selectedProtocol)) {
          setSelectedProtocol(UIType.OPENAI_SDK);
        }
      } else {
        setSelectedProtocol(uiType);
      }
      return;
    }

    // No tool selected - keep the stored protocol preference
    // Don't reset to null here as it would clear the persisted user preference
  }, [selectedTool, tools, setSelectedProtocol, selectedProtocol]);

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

  if (onboarding.isResolvingRemoteCompletion) {
    return (
      <div className="h-full flex flex-col overflow-hidden relative">
        <AppBuilderSkeleton />
      </div>
    );
  }

  if (onboarding.isOverlayVisible) {
    return (
      <div className="h-full flex flex-col overflow-hidden relative">
        <AppBuilderSkeleton />

        {onboarding.isOverlayVisible && (
          <WelcomeOverlay
            phase={onboarding.phase}
            connectError={onboarding.connectError}
            onConnectExcalidraw={onboarding.connectExcalidraw}
            onRetry={onboarding.retryConnect}
          />
        )}
      </div>
    );
  }

  // No server selected — show empty state once onboarding is not active
  if (!serverConfig) {
    return (
      <EmptyState
        icon={Wrench}
        title="No Server Selected"
        description="Connect to an MCP server to use the App Builder."
      />
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden relative">
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
                selectedToolName={selectedTool}
                fetchingTools={fetchingTools}
                onRefresh={fetchTools}
                onSelectTool={setSelectedTool}
                formFields={formFields}
                onFieldChange={updateFormField}
                onToggleField={updateFormFieldIsSet}
                isExecuting={isExecuting}
                onExecute={executeTool}
                onSave={savedRequestsHook.openSaveDialog}
                savedRequests={savedRequestsHook.savedRequests}
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
        ) : !isOnboarding ? (
          <CollapsedPanelStrip
            side="left"
            onOpen={toggleSidebar}
            tooltipText="Show tools sidebar"
          />
        ) : null}

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
            initialInput={
              onboarding.isGuidedPostConnect
                ? "Draw me an MCP architecture diagram"
                : undefined
            }
            pulseSubmit={onboarding.isGuidedPostConnect}
            showPostConnectGuide={onboarding.isGuidedPostConnect}
            onFirstMessageSent={
              onboarding.isGuidedPostConnect
                ? onboarding.completeOnboarding
                : undefined
            }
          />
        </ResizablePanel>
      </ResizablePanelGroup>

      {/* Post-connect guide is now rendered inside PlaygroundMain */}

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
