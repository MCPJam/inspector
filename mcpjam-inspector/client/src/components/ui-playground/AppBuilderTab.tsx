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
import type { Tool } from "@modelcontextprotocol/client";
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
import {
  applyParametersToFields as applyParamsToFields,
  buildParametersFromFields,
  generateFormFieldsFromSchema,
} from "@/lib/tool-form";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import type { WorkspaceHostContextDraft } from "@/lib/client-config";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { waitForUiCommit } from "@/lib/wait-for-ui-commit";
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
import type {
  EnsureServersReadyResult,
  ServerWithName,
} from "@/hooks/use-app-state";
import { useSidebar } from "@/components/ui/sidebar";
import { getLoadingIndicatorVariantForHostStyle } from "@/components/chat-v2/shared/loading-indicator-content";
import type { PlaygroundServerSelectorProps } from "@/components/ActiveServerSelector";
import {
  createInspectorCommandClientError,
  registerInspectorCommandHandler,
} from "@/lib/inspector-command-handlers";
import type {
  ExecuteToolInspectorCommand,
  RenderToolResultInspectorCommand,
  SelectToolInspectorCommand,
  SetAppContextInspectorCommand,
  SnapshotAppInspectorCommand,
} from "@/shared/inspector-command.js";

interface AppBuilderTabProps {
  activeWorkspaceId?: string | null;
  serverConfig?: MCPServerConfig;
  serverName?: string;
  servers?: Record<string, ServerWithName>;
  isAuthenticated?: boolean;
  isAuthLoading?: boolean;
  /**
   * True while the currently selected server exists in runtime state but has
   * not yet appeared in the persisted workspace servers (Convex round-trip
   * pending). Used to show a loading skeleton instead of the "No Server
   * Selected" empty state during the sync window.
   */
  isServerSyncing?: boolean;
  onConnect?: (formData: ServerFormData) => void;
  onSaveHostContext?: (
    workspaceId: string,
    hostContext: WorkspaceHostContextDraft,
  ) => Promise<void>;
  ensureServersReady?: (
    serverNames: string[],
  ) => Promise<EnsureServersReadyResult>;
  onOnboardingChange?: (isOnboarding: boolean) => void;
  playgroundServerSelectorProps?: PlaygroundServerSelectorProps;
  enableMultiModelChat?: boolean;
}

/**
 * Match the sync echo timeout used elsewhere (see
 * `use-workspace-state.ts`'s CLIENT_CONFIG_SYNC_ECHO_TIMEOUT_MS). If the
 * Convex round-trip doesn't land within this window, fall through to an
 * explanatory empty state rather than spinning forever.
 */
const SERVER_SYNC_TIMEOUT_MS = 10000;
const EXECUTION_INJECTION_TIMEOUT_MS = 5000;

const APP_BUILDER_FIRST_RUN_PROMPT = "Draw me an MCP architecture diagram";

const SIDEBAR_EASE: [number, number, number, number] = [0.4, 0, 0.2, 1];

type ExecutionInjectionWaiter = {
  expectedToolCallId?: string;
  reject: (error: unknown) => void;
  resolve: (toolCallId?: string) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

export function AppBuilderTab({
  activeWorkspaceId = null,
  serverConfig,
  serverName,
  servers = {},
  isAuthenticated = false,
  isAuthLoading = false,
  isServerSyncing = false,
  onConnect,
  onSaveHostContext,
  ensureServersReady,
  onOnboardingChange,
  playgroundServerSelectorProps,
  enableMultiModelChat = false,
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
    setDisplayMode,
    updateGlobal,
    toggleSidebar,
    setSelectedProtocol,
    reset,
    setSidebarVisible,
  } = useUIPlaygroundStore();
  const hostStyle = usePreferencesStore((s) => s.hostStyle);

  const { setOpen: setMcpSidebarOpen } = useSidebar();

  useLayoutEffect(() => {
    onOnboardingChange?.(false);
    setMcpSidebarOpen(true);
  }, [onOnboardingChange, setMcpSidebarOpen]);

  useLayoutEffect(() => {
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
  }, [onboarding.phase, onboarding.isGuidedPostConnect, setSidebarVisible]);

  useLayoutEffect(() => {
    return () => {
      onOnboardingChange?.(false);
      setSidebarVisible(true);
      setMcpSidebarOpen(true);
    };
  }, [onOnboardingChange, setMcpSidebarOpen, setSidebarVisible]);

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
  const {
    pendingExecution,
    clearPendingExecution,
    executeTool,
    injectToolResult,
  } = useToolExecution({
    serverName,
    selectedTool,
    toolsMetadata,
    formFields,
    setIsExecuting,
    setExecutionError,
    setToolOutput,
    setToolResponseMetadata,
  });

  const executionInjectionWaitersRef = useRef<ExecutionInjectionWaiter[]>([]);

  const waitForExecutionInjection = useCallback(
    (expectedToolCallId: string | undefined, timeoutMs?: number) => {
      let waiter: ExecutionInjectionWaiter | undefined;
      const effectiveTimeoutMs =
        typeof timeoutMs === "number" && timeoutMs > 0
          ? timeoutMs
          : EXECUTION_INJECTION_TIMEOUT_MS;

      const removeWaiter = () => {
        if (!waiter) return;
        executionInjectionWaitersRef.current =
          executionInjectionWaitersRef.current.filter(
            (entry) => entry !== waiter,
          );
      };

      const promise = new Promise<string | undefined>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          removeWaiter();
          reject(
            createInspectorCommandClientError(
              "timeout",
              `Tool result was not rendered in App Builder within ${effectiveTimeoutMs}ms.`,
            ),
          );
        }, effectiveTimeoutMs);

        waiter = {
          ...(expectedToolCallId ? { expectedToolCallId } : {}),
          reject,
          resolve: (toolCallId?: string) => {
            clearTimeout(timeoutId);
            removeWaiter();
            resolve(toolCallId);
          },
          timeoutId,
        };
        executionInjectionWaitersRef.current.push(waiter);
      });

      return {
        cancel: () => {
          if (!waiter) return;
          clearTimeout(waiter.timeoutId);
          removeWaiter();
        },
        promise,
      };
    },
    [],
  );

  const handleExecutionInjected = useCallback(
    (toolCallId?: string) => {
      clearPendingExecution();
      const resolvedWaiters: ExecutionInjectionWaiter[] = [];
      const pendingWaiters: ExecutionInjectionWaiter[] = [];
      for (const waiter of executionInjectionWaitersRef.current) {
        if (
          !waiter.expectedToolCallId ||
          waiter.expectedToolCallId === toolCallId
        ) {
          resolvedWaiters.push(waiter);
        } else {
          pendingWaiters.push(waiter);
        }
      }
      executionInjectionWaitersRef.current = pendingWaiters;
      for (const waiter of resolvedWaiters) {
        waiter.resolve(toolCallId);
      }
    },
    [clearPendingExecution],
  );

  useEffect(() => {
    return () => {
      const waiters = executionInjectionWaitersRef.current.splice(0);
      for (const waiter of waiters) {
        clearTimeout(waiter.timeoutId);
        waiter.reject(
          createInspectorCommandClientError(
            "unsupported_in_mode",
            "App Builder unmounted before the tool result rendered.",
          ),
        );
      }
    };
  }, []);

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

  const loadToolsUntilMatch = useCallback(
    async (toolName?: string) => {
      if (!serverName) {
        throw createInspectorCommandClientError(
          "disconnected_server",
          "No server is selected in the App Builder.",
        );
      }

      if (!toolName && Object.keys(tools).length > 0) {
        return {
          tools,
          metadata: toolsMetadata,
        };
      }

      if (toolName && tools[toolName]) {
        return {
          tools,
          metadata: toolsMetadata,
        };
      }

      setFetchingTools(true);
      try {
        const aggregatedTools = { ...tools };
        const aggregatedMetadata = { ...toolsMetadata };
        let cursor: string | undefined;
        let pages = 0;
        const maxPages = 25;

        do {
          const data = await listTools({ serverId: serverName, cursor });
          const toolArray = data.tools ?? [];
          const dictionary = Object.fromEntries(
            toolArray.map((tool: Tool) => [tool.name, tool]),
          );

          Object.assign(aggregatedTools, dictionary);
          Object.assign(aggregatedMetadata, data.toolsMetadata ?? {});
          cursor = data.nextCursor;
          pages += 1;

          if (
            toolName &&
            !aggregatedTools[toolName] &&
            cursor &&
            pages >= maxPages
          ) {
            const message = `Stopped fetching tools after ${maxPages} pages without finding "${toolName}".`;
            setExecutionError(message);
            throw createInspectorCommandClientError(
              "execution_failed",
              message,
            );
          }

          if (!toolName || aggregatedTools[toolName] || !cursor) {
            break;
          }
        } while (true);

        setTools(aggregatedTools);
        setToolsMetadata(aggregatedMetadata);

        return {
          tools: aggregatedTools,
          metadata: aggregatedMetadata,
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to fetch tools";
        setExecutionError(message);
        throw createInspectorCommandClientError("execution_failed", message);
      } finally {
        setFetchingTools(false);
      }
    },
    [serverName, setExecutionError, setTools, tools, toolsMetadata],
  );

  const buildAppBuilderSnapshot = useCallback(() => {
    const playgroundState = useUIPlaygroundStore.getState();

    return {
      serverName: serverName ?? null,
      selectedTool: playgroundState.selectedTool,
      selectedProtocol: playgroundState.selectedProtocol,
      deviceType: playgroundState.deviceType,
      displayMode: playgroundState.displayMode,
      globals: playgroundState.globals,
      toolOutput: playgroundState.toolOutput,
      toolResponseMetadata: playgroundState.toolResponseMetadata,
      widgetUrl: playgroundState.widgetUrl,
      widgetState: playgroundState.widgetState,
      executionError: playgroundState.executionError,
      isExecuting: playgroundState.isExecuting,
    };
  }, [serverName]);

  const serverConnectionStatus = serverName
    ? servers[serverName]?.connectionStatus
    : undefined;

  const prevServerRef = useRef<{
    serverName: string | null;
    status: string | undefined;
  }>({ serverName: null, status: undefined });

  useEffect(() => {
    const prev = prevServerRef.current;
    const serverChanged = serverName !== prev.serverName;
    const statusChanged = serverConnectionStatus !== prev.status;
    prevServerRef.current = {
      serverName: serverName ?? null,
      status: serverConnectionStatus,
    };

    if (serverConfig && serverName && serverConnectionStatus === "connected") {
      // Skip re-fetch when tools are already loaded and only the object
      // reference changed (e.g. a SYNC_AGENT_STATUS that didn't change status).
      if (!serverChanged && !statusChanged && Object.keys(tools).length > 0) {
        return;
      }
      fetchTools();
    } else {
      reset();
      setToolsMetadata({});
    }
  }, [
    serverConfig,
    serverName,
    serverConnectionStatus,
    fetchTools,
    reset,
    tools,
  ]);

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

  const selectToolForCommand = useCallback(
    async (
      command:
        | SelectToolInspectorCommand
        | ExecuteToolInspectorCommand
        | RenderToolResultInspectorCommand,
    ) => {
      if (command.payload.surface !== "app-builder") {
        throw createInspectorCommandClientError(
          "unsupported_in_mode",
          `AppBuilderTab cannot handle ${command.type} for ${command.payload.surface}.`,
        );
      }

      if (
        !serverConfig ||
        !serverName ||
        serverConnectionStatus !== "connected"
      ) {
        throw createInspectorCommandClientError(
          "disconnected_server",
          "The App Builder requires a connected server before tools can be selected.",
        );
      }

      if (
        command.payload.serverName &&
        command.payload.serverName !== serverName
      ) {
        throw createInspectorCommandClientError(
          "unknown_server",
          `App Builder is focused on "${serverName}", not "${command.payload.serverName}".`,
        );
      }

      const { tools: availableTools } = await loadToolsUntilMatch(
        command.payload.toolName,
      );
      const tool = availableTools[command.payload.toolName];
      if (!tool) {
        throw createInspectorCommandClientError(
          "unknown_tool",
          `Unknown tool "${command.payload.toolName}" on server "${serverName}".`,
        );
      }

      const nextFormFields = generateFormFieldsFromSchema(tool.inputSchema);
      const currentState = useUIPlaygroundStore.getState();
      const shouldSwitchTool =
        currentState.selectedTool !== command.payload.toolName;
      const resolvedParameters =
        command.payload.parameters ??
        (shouldSwitchTool
          ? buildParametersFromFields(nextFormFields)
          : buildParametersFromFields(currentState.formFields));

      if (shouldSwitchTool) {
        setSelectedTool(command.payload.toolName);
        await waitForUiCommit();
      } else if (currentState.formFields.length === 0) {
        setFormFields(nextFormFields);
        await waitForUiCommit();
      }

      if (command.payload.parameters) {
        const latestFields = useUIPlaygroundStore.getState().formFields;
        setFormFields(
          applyParamsToFields(latestFields, command.payload.parameters),
        );
        await waitForUiCommit();
      }

      return {
        serverName,
        tool,
        parameters: resolvedParameters,
      };
    },
    [
      loadToolsUntilMatch,
      serverConfig,
      serverConnectionStatus,
      serverName,
      setFormFields,
      setSelectedTool,
    ],
  );

  const resolveCommandProtocol = useCallback(
    (protocol?: SetAppContextInspectorCommand["payload"]["protocol"]) => {
      if (!protocol) {
        return undefined;
      }

      if (protocol === UIType.MCP_APPS) {
        return UIType.MCP_APPS;
      }

      if (protocol === UIType.OPENAI_SDK) {
        return UIType.OPENAI_SDK;
      }

      throw createInspectorCommandClientError(
        "invalid_request",
        `Unsupported protocol "${protocol}".`,
      );
    },
    [],
  );

  // useLayoutEffect so command handlers update synchronously during commit —
  // before setTimeout(0)-based waitForUiCommit() resolves.  This prevents
  // stale-closure races when sequential commands (e.g. openAppBuilder then
  // renderToolResult) arrive faster than useEffect would re-register handlers.
  useLayoutEffect(() => {
    const unregisterSelectTool = registerInspectorCommandHandler(
      "selectTool",
      async (rawCommand) => {
        const command = rawCommand as SelectToolInspectorCommand;
        const selection = await selectToolForCommand(command);

        return {
          ...buildAppBuilderSnapshot(),
          serverName: selection.serverName,
          toolName: command.payload.toolName,
          parameterKeys: Object.keys(selection.parameters),
        };
      },
    );

    const unregisterExecuteTool = registerInspectorCommandHandler(
      "executeTool",
      async (rawCommand) => {
        const command = rawCommand as ExecuteToolInspectorCommand;
        const selection = await selectToolForCommand(command);
        const outcome = await executeTool({
          toolName: command.payload.toolName,
          parameters: selection.parameters,
        });
        await waitForUiCommit();

        if (!outcome.ok) {
          throw createInspectorCommandClientError(
            "execution_failed",
            outcome.error,
            outcome.response,
          );
        }

        return {
          ...buildAppBuilderSnapshot(),
          serverName: selection.serverName,
          toolName: outcome.toolName,
          parameters: outcome.parameters,
          result: outcome.result,
        };
      },
    );

    const unregisterRenderToolResult = registerInspectorCommandHandler(
      "renderToolResult",
      async (rawCommand) => {
        const command = rawCommand as RenderToolResultInspectorCommand;
        const selection = await selectToolForCommand(command);
        const injection = waitForExecutionInjection(
          command.id,
          command.timeoutMs,
        );
        let outcome: Awaited<ReturnType<typeof injectToolResult>>;
        try {
          outcome = await injectToolResult({
            toolName: command.payload.toolName,
            parameters: selection.parameters,
            result: command.payload.result,
            toolCallId: command.id,
          });
          await injection.promise;
        } finally {
          injection.cancel();
        }
        await waitForUiCommit();

        return {
          ...buildAppBuilderSnapshot(),
          serverName: selection.serverName,
          toolName: outcome.toolName,
          parameters: outcome.parameters,
          result: outcome.result,
        };
      },
    );

    const unregisterSetAppContext = registerInspectorCommandHandler(
      "setAppContext",
      async (rawCommand) => {
        const command = rawCommand as SetAppContextInspectorCommand;
        const protocol = resolveCommandProtocol(command.payload.protocol);

        if (command.payload.deviceType) {
          setDeviceType(command.payload.deviceType);
        }
        if (command.payload.displayMode) {
          setDisplayMode(command.payload.displayMode);
        }
        if (command.payload.locale) {
          updateGlobal("locale", command.payload.locale);
        }
        if (command.payload.timeZone) {
          updateGlobal("timeZone", command.payload.timeZone);
        }
        if (command.payload.theme) {
          updateGlobal("theme", command.payload.theme);
        }
        if (protocol) {
          setSelectedProtocol(protocol);
        }

        await waitForUiCommit();
        return buildAppBuilderSnapshot();
      },
    );

    const unregisterSnapshotApp = registerInspectorCommandHandler(
      "snapshotApp",
      async (rawCommand) => {
        const command = rawCommand as SnapshotAppInspectorCommand;
        if (
          command.payload.surface &&
          command.payload.surface !== "app-builder"
        ) {
          throw createInspectorCommandClientError(
            "unsupported_in_mode",
            `AppBuilderTab cannot snapshot ${command.payload.surface}.`,
          );
        }

        return buildAppBuilderSnapshot();
      },
    );

    return () => {
      unregisterSelectTool();
      unregisterExecuteTool();
      unregisterRenderToolResult();
      unregisterSetAppContext();
      unregisterSnapshotApp();
    };
  }, [
    buildAppBuilderSnapshot,
    executeTool,
    injectToolResult,
    resolveCommandProtocol,
    selectToolForCommand,
    setDeviceType,
    setDisplayMode,
    setSelectedProtocol,
    updateGlobal,
    waitForExecutionInjection,
  ]);

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

  // Track whether the in-flight server sync has exceeded the timeout. Resets
  // whenever the selected server changes or syncing stops, so a successful
  // echo never leaves a stale "taking longer" banner behind.
  const [syncTimedOut, setSyncTimedOut] = useState(false);
  useEffect(() => {
    setSyncTimedOut(false);
    if (!isServerSyncing) return;
    const id = setTimeout(() => setSyncTimedOut(true), SERVER_SYNC_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [serverName, isServerSyncing]);

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

  // Server is in runtime state but not yet reflected in the persisted
  // workspace (Convex round-trip pending). Show a skeleton instead of the
  // misleading "No Server Selected" empty state during the sync window.
  if (!serverConfig && isServerSyncing && !syncTimedOut) {
    return (
      <div className="h-full flex flex-col overflow-hidden relative">
        <AppBuilderSkeleton />
      </div>
    );
  }

  // Sync is taking unusually long — surface an explanation so the user
  // isn't staring at an infinite spinner.
  if (!serverConfig && isServerSyncing && syncTimedOut) {
    return (
      <EmptyState
        icon={Wrench}
        title="Still syncing…"
        description="This is taking longer than expected. Try reloading the page."
      />
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
          className="min-h-0 min-w-0 overflow-hidden"
        >
          <PlaygroundMain
            activeWorkspaceId={activeWorkspaceId}
            serverName={serverName || ""}
            onSaveHostContext={onSaveHostContext}
            enableMultiModelChat={enableMultiModelChat}
            isExecuting={isExecuting}
            executingToolName={selectedTool}
            invokingMessage={invokingMessage}
            pendingExecution={pendingExecution}
            onExecutionInjected={handleExecutionInjected}
            onWidgetStateChange={(_toolCallId, state) => setWidgetState(state)}
            deviceType={deviceType}
            onDeviceTypeChange={setDeviceType}
            playgroundServerSelectorProps={playgroundServerSelectorProps}
            initialInput={
              firstRunComposerSeed ? APP_BUILDER_FIRST_RUN_PROMPT : undefined
            }
            initialInputTypewriter={firstRunComposerSeed}
            blockSubmitUntilServerConnected={firstRunComposerSeed}
            loadingIndicatorVariant={getLoadingIndicatorVariantForHostStyle(
              hostStyle,
            )}
            ensureServersReady={ensureServersReady}
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
