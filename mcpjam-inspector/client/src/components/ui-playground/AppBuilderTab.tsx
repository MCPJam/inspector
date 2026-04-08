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
import { motion, useReducedMotion } from "framer-motion";

// Custom hooks
import { useServerKey, useSavedRequests, useToolExecution } from "./hooks";

// Constants
import { PANEL_SIZES } from "./constants";
import { UIType, detectUiTypeFromTool } from "@/lib/mcp-ui/mcp-apps-utils";

// Onboarding
import { useOnboarding } from "@/hooks/use-onboarding";
import { AppBuilderSkeleton } from "@/components/app-builder/AppBuilderSkeleton";
import type { ServerFormData } from "@/shared/types.js";
import type { ServerWithName } from "@/hooks/use-app-state";
import { useSidebar } from "@/components/ui/sidebar";
import { toast } from "sonner";
import type { PlaygroundServerSelectorProps } from "@/components/ActiveServerSelector";

interface AppBuilderTabProps {
  serverConfig?: MCPServerConfig;
  serverName?: string;
  servers?: Record<string, ServerWithName>;
  isAuthenticated?: boolean;
  isAuthLoading?: boolean;
  onConnect?: (formData: ServerFormData) => void;
  onOnboardingChange?: (isOnboarding: boolean) => void;
  playgroundServerSelectorProps?: PlaygroundServerSelectorProps;
}

const APP_BUILDER_FIRST_RUN_PROMPT = "Draw me an MCP architecture diagram";

const SIDEBAR_EASE: [number, number, number, number] = [0.4, 0, 0.2, 1];

export function AppBuilderTab({
  serverConfig,
  serverName,
  servers = {},
  isAuthenticated = false,
  isAuthLoading = false,
  onConnect,
  onOnboardingChange,
  playgroundServerSelectorProps,
}: AppBuilderTabProps) {
  const posthog = usePostHog();
  const prefersReducedMotion = useReducedMotion();
  // Compute server key for saved requests storage
  const serverKey = useServerKey(serverConfig);

  // Onboarding state machine
  const onboarding = useOnboarding({
    servers,
    onConnect: onConnect ?? (() => {}),
    isAuthenticated,
    isAuthLoading,
  });

  const firstRunComposerSeed =
    onboarding.phase === "connecting_excalidraw" ||
    onboarding.phase === "connected_guided";

  // Get store state and actions
  const {
    selectedTool,
    tools,
    formFields,
    isExecuting,
    deviceType,
    hostStyle,
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

  const { setOpen: setMcpSidebarOpen } = useSidebar();

  useLayoutEffect(() => {
    onOnboardingChange?.(false);
    setMcpSidebarOpen(true);
    // NUX: collapse tools sidebar for the whole first-run connect + guided flow. While the server is
    // still connecting, `isGuidedPostConnect` is false (no connected server yet); include phase so we
    // don't flash the sidebar open until connect completes.
    const collapsePlaygroundToolsForNux =
      onboarding.phase === "connecting_excalidraw" ||
      onboarding.isGuidedPostConnect;
    if (collapsePlaygroundToolsForNux) {
      setSidebarVisible(false);
    } else {
      setSidebarVisible(true);
    }
    return () => {
      onOnboardingChange?.(false);
      setSidebarVisible(true);
      setMcpSidebarOpen(true);
    };
  }, [
    onboarding.phase,
    onboarding.isGuidedPostConnect,
    onOnboardingChange,
    setMcpSidebarOpen,
    setSidebarVisible,
  ]);

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

  if (onboarding.isBootstrappingFirstRunConnection && onConnect) {
    return (
      <div className="h-full flex flex-col overflow-hidden relative">
        <AppBuilderSkeleton />
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

  const sidebarMotionProps = prefersReducedMotion
    ? {
        initial: false as const,
        animate: { opacity: 1 },
        transition: { duration: 0 },
      }
    : {
        initial: { opacity: 0, x: -12 },
        animate: { opacity: 1, x: 0 },
        transition: { duration: 0.22, ease: SIDEBAR_EASE },
      };

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
        {/* Left Panel - Tools Sidebar */}
        {isSidebarVisible ? (
          <>
            <ResizablePanel
              id="playground-left"
              order={1}
              defaultSize={PANEL_SIZES.LEFT.DEFAULT}
              minSize={PANEL_SIZES.LEFT.MIN}
              maxSize={PANEL_SIZES.LEFT.MAX}
              collapsible
              collapsedSize={0}
              onCollapse={() => setSidebarVisible(false)}
            >
              <motion.div className="h-full min-w-0" {...sidebarMotionProps}>
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
              </motion.div>
            </ResizablePanel>
            <ResizableHandle withHandle />
          </>
        ) : (
          <motion.div
            className="flex h-full min-w-0 shrink-0"
            {...sidebarMotionProps}
          >
            <CollapsedPanelStrip
              side="left"
              onOpen={toggleSidebar}
              tooltipText="Show tools sidebar"
            />
          </motion.div>
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
            playgroundServerSelectorProps={playgroundServerSelectorProps}
            initialInput={
              firstRunComposerSeed ? APP_BUILDER_FIRST_RUN_PROMPT : undefined
            }
            initialInputTypewriter={firstRunComposerSeed}
            blockSubmitUntilServerConnected={firstRunComposerSeed}
            loadingIndicatorVariant={
              hostStyle === "chatgpt" ? "chatgpt-dot" : "claude-mark"
            }
            pulseSubmit={firstRunComposerSeed}
            showPostConnectGuide={false}
            onFirstMessageSent={
              onboarding.isGuidedPostConnect
                ? () => {
                    setSidebarVisible(true);
                    onboarding.completeOnboarding();
                  }
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
