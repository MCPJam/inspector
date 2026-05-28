/**
 * useAppBuilderState
 *
 * Owns the orchestration that previously lived inline in `AppBuilderTab`:
 * tool fetching, form-field sync, saved-requests bridge, execution + result
 * injection waiters, onboarding integration, and the inspector command
 * handlers (`selectTool` / `executeTool` / `renderToolResult` / `setAppContext`
 * / `snapshotApp`).
 *
 * Both `AppBuilderTab` (legacy route) and `PlaygroundTab` (new IDE shell) can
 * call this hook and compose their own JSX around the returned values. Keeps
 * the two surfaces in lockstep so an inspector command sent at one is
 * indistinguishable from one sent at the other.
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Tool } from "@modelcontextprotocol/client";
import { useReducedMotion } from "framer-motion";
import { usePostHog } from "posthog-js/react";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { listTools } from "@/lib/apis/mcp-tools-api";
import {
  applyParametersToFields as applyParamsToFields,
  buildParametersFromFields,
  generateFormFieldsFromSchema,
} from "@/lib/tool-form";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import type { ProjectHostContextDraft } from "@/lib/client-config";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { waitForUiCommit } from "@/lib/wait-for-ui-commit";
import { useOnboarding } from "@/hooks/use-onboarding";
import type { ServerFormData } from "@/shared/types.js";
import type {
  EnsureServersReadyResult,
  ServerWithName,
} from "@/hooks/use-app-state";
import { useSidebar } from "@/components/ui/sidebar";
import {
  createInspectorCommandClientError,
  registerInspectorCommandHandler,
} from "@/lib/inspector-command-handlers";
import { useAppToolsRegistry } from "@/components/chat-v2/thread/mcp-apps/app-tools-registry";
import {
  getApiContextRevision,
  subscribeApiContext,
} from "@/lib/apis/web/context";
import type {
  ExecuteToolInspectorCommand,
  RenderToolResultInspectorCommand,
  SelectToolInspectorCommand,
  SetAppContextInspectorCommand,
  SnapshotAppInspectorCommand,
} from "@/shared/inspector-command.js";
import { useSavedRequests, useServerKey, useToolExecution } from "./index";
import { PANEL_SIZES } from "../constants";

const SERVER_SYNC_TIMEOUT_MS = 10000;
const EXECUTION_INJECTION_TIMEOUT_MS = 5000;

export const APP_BUILDER_FIRST_RUN_PROMPT =
  "Draw me an MCP architecture diagram";

type ExecutionInjectionWaiter = {
  expectedToolCallId?: string;
  reject: (error: unknown) => void;
  resolve: (toolCallId?: string) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

export interface UseAppBuilderStateOptions {
  activeProjectId?: string | null;
  serverConfig?: MCPServerConfig;
  serverName?: string;
  servers?: Record<string, ServerWithName>;
  isSignedInWithWorkOs?: boolean;
  isWorkOsAuthLoading?: boolean;
  isConvexAuthenticated?: boolean;
  isProjectProvisioned?: boolean;
  hasSeenFirstRunOnboarding?: boolean;
  isServerSyncing?: boolean;
  onConnect?: (formData: ServerFormData) => void;
  onSaveHostContext?: (
    projectId: string,
    hostContext: ProjectHostContextDraft
  ) => Promise<void>;
  ensureServersReady?: (
    serverNames: string[]
  ) => Promise<EnsureServersReadyResult>;
  onOnboardingChange?: (isOnboarding: boolean) => void;
  /**
   * Active multi-server selection. When non-empty, the Playground tools pane
   * aggregates tools across these servers; tool execution routes to the
   * server scoped to the clicked tool (see `executeTool({ serverName })`).
   * Empty / undefined falls back to single-server mode driven by `serverName`.
   */
  selectedServerNames?: string[];
  /**
   * Which surface is hosting this hook. Tagged onto the view-event for
   * PostHog so we can split Playground vs App Builder usage. The event name
   * itself stays `app_builder_tab_viewed` for continuity.
   */
  surface?: "app-builder" | "playground";
}

/**
 * Render-phase signal so consumers can switch on a discriminated union
 * instead of chaining if-elses. `ready` is the steady state; the others are
 * the early-return branches AppBuilderTab used to handle inline.
 */
export type AppBuilderLoadingState =
  | { kind: "ready" }
  | { kind: "skeleton" }
  | { kind: "sync-timed-out" }
  | { kind: "no-server" };

export type UseAppBuilderStateReturn = ReturnType<typeof useAppBuilderState>;

/**
 * Pick the servers whose tools should appear in the Playground tools pane
 * and be callable by the manual Run button. Mirrors the predicate the LLM
 * tools list (`PlaygroundMain.tsx`) and composer popover (`chat-input.tsx`)
 * already use, so all three surfaces agree on what "in-use" means and the
 * pane stays in sync with the user's connection toggle.
 *
 * Multi-server (Playground) passes `selectedServerNames`; single-server
 * (App Builder) passes `serverName`. Either way the filter rejects anything
 * not currently in `connectionStatus === "connected"`.
 */
export function selectConnectedActiveServerNames(input: {
  selectedServerNames: ReadonlyArray<string> | undefined;
  serverName: string | undefined;
  servers: Record<string, ServerWithName>;
}): string[] {
  const { selectedServerNames, serverName, servers } = input;
  const isConnected = (name: string) =>
    servers[name]?.connectionStatus === "connected";
  if (selectedServerNames && selectedServerNames.length > 0) {
    return selectedServerNames.filter(isConnected);
  }
  return serverName && isConnected(serverName) ? [serverName] : [];
}

export function useAppBuilderState(options: UseAppBuilderStateOptions) {
  const {
    serverConfig,
    serverName,
    servers = {},
    isSignedInWithWorkOs = false,
    isWorkOsAuthLoading = false,
    isConvexAuthenticated = false,
    isProjectProvisioned = true,
    hasSeenFirstRunOnboarding,
    isServerSyncing = false,
    onConnect,
    onOnboardingChange,
    selectedServerNames,
    surface = "app-builder",
  } = options;

  const activeServerNames = useMemo(
    () =>
      selectConnectedActiveServerNames({
        selectedServerNames,
        serverName,
        servers,
      }),
    [selectedServerNames, serverName, servers]
  );

  const posthog = usePostHog();
  const prefersReducedMotion = useReducedMotion();
  const serverKey = useServerKey(serverConfig);

  const onboarding = useOnboarding({
    servers,
    onConnect: onConnect ?? (() => {}),
    isSignedInWithWorkOs,
    isWorkOsAuthLoading,
    hasRemoteOnboardingState: hasSeenFirstRunOnboarding !== undefined,
    hasSeenOnboarding: hasSeenFirstRunOnboarding === true,
    canPersistRemoteOnboarding: isConvexAuthenticated,
    isProjectProvisioned,
  });

  const firstRunComposerSeed =
    onboarding.phase === "connecting_excalidraw" ||
    onboarding.phase === "connected_guided";

  const {
    selectedTool,
    tools,
    formFields,
    isExecuting,
    deviceType,
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
    setSidebarVisible,
  } = useUIPlaygroundStore();
  const hostStyle = usePreferencesStore((s) => s.hostStyle);

  const { setOpen: setMcpSidebarOpen } = useSidebar();

  useLayoutEffect(() => {
    onOnboardingChange?.(false);
    setMcpSidebarOpen(true);
  }, [onOnboardingChange, setMcpSidebarOpen]);

  useLayoutEffect(() => {
    // NUX: collapse the tools sidebar for the whole first-run connect + guided
    // flow. While the server is still connecting, `isGuidedPostConnect` is
    // false; checking phase too avoids flashing the sidebar open until
    // connect completes.
    const collapseToolsForNux =
      onboarding.phase === "connecting_excalidraw" ||
      onboarding.isGuidedPostConnect;
    if (collapseToolsForNux) {
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

  // Log when the app-builder surface is viewed. The event name stays
  // `app_builder_tab_viewed` even for the Playground surface — telemetry
  // continuity is more valuable than a name swap here. `surface` lets PostHog
  // split Playground vs App Builder usage.
  useEffect(() => {
    posthog.capture("app_builder_tab_viewed", {
      location: "app_builder_tab",
      surface,
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [fetchingTools, setFetchingTools] = useState(false);
  const [toolsMetadata, setToolsMetadata] = useState<
    Record<string, Record<string, unknown>>
  >({});

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
  const apiContextRevision = useSyncExternalStore(
    subscribeApiContext,
    getApiContextRevision,
    getApiContextRevision
  );

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
            (entry) => entry !== waiter
          );
      };

      const promise = new Promise<string | undefined>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          removeWaiter();
          reject(
            createInspectorCommandClientError(
              "timeout",
              `Tool result was not rendered in Playground within ${effectiveTimeoutMs}ms.`
            )
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
    []
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
    [clearPendingExecution]
  );

  useEffect(() => {
    return () => {
      const waiters = executionInjectionWaitersRef.current.splice(0);
      for (const waiter of waiters) {
        clearTimeout(waiter.timeoutId);
        waiter.reject(
          createInspectorCommandClientError(
            "unsupported_in_mode",
            "Playground unmounted before the tool result rendered."
          )
        );
      }
    };
  }, []);

  const savedRequestsHook = useSavedRequests({
    serverKey,
    tools,
    formFields,
    selectedTool,
    setSelectedTool,
    setFormFields,
  });

  const fetchTools = useCallback(async () => {
    if (!serverName) return;

    reset();
    setToolsMetadata({});
    setFetchingTools(true);
    try {
      const data = await listTools({ serverId: serverName });
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
    } finally {
      setFetchingTools(false);
    }
  }, [serverName, reset, setTools, setExecutionError, apiContextRevision]);

  const loadToolsUntilMatch = useCallback(
    async (toolName?: string) => {
      if (!serverName) {
        throw createInspectorCommandClientError(
          "disconnected_server",
          "No server is selected in the Playground."
        );
      }

      if (!toolName && Object.keys(tools).length > 0) {
        return { tools, metadata: toolsMetadata };
      }

      if (toolName && tools[toolName]) {
        return { tools, metadata: toolsMetadata };
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
            toolArray.map((tool: Tool) => [tool.name, tool])
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
              message
            );
          }

          if (!toolName || aggregatedTools[toolName] || !cursor) {
            break;
          }
        } while (true);

        setTools(aggregatedTools);
        setToolsMetadata(aggregatedMetadata);

        return { tools: aggregatedTools, metadata: aggregatedMetadata };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to fetch tools";
        setExecutionError(message);
        throw createInspectorCommandClientError("execution_failed", message);
      } finally {
        setFetchingTools(false);
      }
    },
    [serverName, setExecutionError, setTools, tools, toolsMetadata]
  );

  const buildAppBuilderSnapshot = useCallback(() => {
    const playgroundState = useUIPlaygroundStore.getState();

    return {
      serverName: serverName ?? null,
      selectedTool: playgroundState.selectedTool,
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
    apiContextRevision,
    fetchTools,
    reset,
    tools,
  ]);

  // Subscribe to the app-tools registry so form fields regenerate when an
  // app re-lists its tools (e.g. inputSchema changes mid-session). Returning
  // the resolved descriptor keeps the schema reference stable across renders
  // that didn't actually change the registry entry. Routes through the
  // registry's `resolve()` so we inherit its `activeBridgeByParent` gate
  // (a superseded sibling instance won't be treated as live).
  const selectedAppToolDescriptor = useAppToolsRegistry((s) => {
    if (!selectedTool) return undefined;
    const resolved = s.resolve(selectedTool);
    if (!resolved) return undefined;
    return resolved.instance.tools.find((t) => t.name === resolved.rawName);
  });

  useEffect(() => {
    if (selectedTool && tools[selectedTool]) {
      setFormFields(
        generateFormFieldsFromSchema(tools[selectedTool].inputSchema)
      );
      return;
    }
    if (selectedAppToolDescriptor) {
      setFormFields(
        generateFormFieldsFromSchema(selectedAppToolDescriptor.inputSchema)
      );
      return;
    }
    setFormFields([]);
  }, [selectedTool, tools, selectedAppToolDescriptor, setFormFields]);

  const selectToolForCommand = useCallback(
    async (
      command:
        | SelectToolInspectorCommand
        | ExecuteToolInspectorCommand
        | RenderToolResultInspectorCommand
    ) => {
      // Accept both `app-builder` (legacy) and `playground` (transition). Only
      // the Playground surface mounts now, so at most one consumer is alive at
      // a time — no double-handler race.
      if (
        command.payload.surface !== "app-builder" &&
        command.payload.surface !== "playground"
      ) {
        throw createInspectorCommandClientError(
          "unsupported_in_mode",
          `Playground cannot handle ${command.type} for ${command.payload.surface}.`
        );
      }

      if (
        !serverConfig ||
        !serverName ||
        serverConnectionStatus !== "connected"
      ) {
        throw createInspectorCommandClientError(
          "disconnected_server",
          "The Playground requires a connected server before tools can be selected."
        );
      }

      if (
        command.payload.serverName &&
        command.payload.serverName !== serverName
      ) {
        throw createInspectorCommandClientError(
          "unknown_server",
          `Playground is focused on "${serverName}", not "${command.payload.serverName}".`
        );
      }

      const { tools: availableTools } = await loadToolsUntilMatch(
        command.payload.toolName
      );
      const tool = availableTools[command.payload.toolName];
      if (!tool) {
        throw createInspectorCommandClientError(
          "unknown_tool",
          `Unknown tool "${command.payload.toolName}" on server "${serverName}".`
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
          applyParamsToFields(latestFields, command.payload.parameters)
        );
        await waitForUiCommit();
      }

      return { serverName, tool, parameters: resolvedParameters };
    },
    [
      loadToolsUntilMatch,
      serverConfig,
      serverConnectionStatus,
      serverName,
      setFormFields,
      setSelectedTool,
    ]
  );

  // useLayoutEffect so handlers update synchronously during commit — before
  // setTimeout(0)-based waitForUiCommit() resolves. Prevents stale-closure
  // races when sequential commands arrive faster than useEffect re-registers.
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
      }
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
            outcome.response
          );
        }

        return {
          ...buildAppBuilderSnapshot(),
          serverName: selection.serverName,
          toolName: outcome.toolName,
          parameters: outcome.parameters,
          result: outcome.result,
        };
      }
    );

    const unregisterRenderToolResult = registerInspectorCommandHandler(
      "renderToolResult",
      async (rawCommand) => {
        const command = rawCommand as RenderToolResultInspectorCommand;
        const selection = await selectToolForCommand(command);
        const injection = waitForExecutionInjection(
          command.id,
          command.timeoutMs
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
      }
    );

    const unregisterSetAppContext = registerInspectorCommandHandler(
      "setAppContext",
      async (rawCommand) => {
        const command = rawCommand as SetAppContextInspectorCommand;

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

        await waitForUiCommit();
        return buildAppBuilderSnapshot();
      }
    );

    const unregisterSnapshotApp = registerInspectorCommandHandler(
      "snapshotApp",
      async (rawCommand) => {
        const command = rawCommand as SnapshotAppInspectorCommand;
        if (
          command.payload.surface &&
          command.payload.surface !== "app-builder" &&
          command.payload.surface !== "playground"
        ) {
          throw createInspectorCommandClientError(
            "unsupported_in_mode",
            `Playground cannot snapshot ${command.payload.surface}.`
          );
        }

        return buildAppBuilderSnapshot();
      }
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
    selectToolForCommand,
    setDeviceType,
    setDisplayMode,
    updateGlobal,
    waitForExecutionInjection,
  ]);

  const invokingMessage = useMemo(() => {
    if (!selectedTool) return null;
    const meta = toolsMetadata[selectedTool];
    return (meta?.["openai/toolInvocation/invoking"] as string) ?? null;
  }, [selectedTool, toolsMetadata]);

  const centerPanelDefaultSize = isSidebarVisible
    ? PANEL_SIZES.CENTER.DEFAULT_WITH_PANELS
    : PANEL_SIZES.CENTER.DEFAULT_WITHOUT_PANELS;

  const [syncTimedOut, setSyncTimedOut] = useState(false);
  useEffect(() => {
    setSyncTimedOut(false);
    if (!isServerSyncing) return;
    const id = setTimeout(() => setSyncTimedOut(true), SERVER_SYNC_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [serverName, isServerSyncing]);

  const isResolvingRemoteCompletion = onboarding.isResolvingRemoteCompletion;
  const isBootstrappingFirstRunConnection =
    onboarding.isBootstrappingFirstRunConnection && !!onConnect;
  const isWaitingForServerSync =
    !serverConfig && isServerSyncing && !syncTimedOut;
  const shouldMarkFirstRunNuxShown =
    firstRunComposerSeed &&
    onboarding.isGuidedPostConnect &&
    !isResolvingRemoteCompletion &&
    !isBootstrappingFirstRunConnection &&
    !isWaitingForServerSync &&
    !!serverConfig;

  useEffect(() => {
    if (shouldMarkFirstRunNuxShown) {
      onboarding.markOnboardingShown();
    }
  }, [onboarding.markOnboardingShown, shouldMarkFirstRunNuxShown]);

  const loadingState: AppBuilderLoadingState =
    isResolvingRemoteCompletion ||
    isBootstrappingFirstRunConnection ||
    isWaitingForServerSync
      ? { kind: "skeleton" }
      : !serverConfig && isServerSyncing && syncTimedOut
      ? { kind: "sync-timed-out" }
      : !serverConfig
      ? { kind: "no-server" }
      : { kind: "ready" };

  return {
    loadingState,

    // tools
    tools,
    toolsMetadata,
    selectedTool,
    fetchingTools,
    fetchTools,
    setSelectedTool,
    formFields,
    updateFormField,
    updateFormFieldIsSet,
    isExecuting,
    executeTool,
    invokingMessage,

    // execution injection
    pendingExecution,
    handleExecutionInjected,
    setWidgetState,
    deviceType,
    setDeviceType,

    // saved requests
    savedRequestsHook,

    // layout
    isSidebarVisible,
    setSidebarVisible,
    toggleSidebar,
    centerPanelDefaultSize,

    // onboarding
    firstRunComposerSeed,
    onboarding,

    // multi-server
    activeServerNames,

    // misc
    hostStyle,
    prefersReducedMotion,
  };
}

/**
 * Context bridge so the docked Playground tools pane and the playground center
 * pane can share a single `useAppBuilderState()` call (the hook owns React
 * state, refs, and inspector command registrations — calling it twice would
 * double-register handlers).
 */
const AppBuilderStateContext = createContext<UseAppBuilderStateReturn | null>(
  null
);

export function AppBuilderStateProvider({
  value,
  children,
}: {
  value: UseAppBuilderStateReturn;
  children: ReactNode;
}) {
  return createElement(AppBuilderStateContext.Provider, { value }, children);
}

export function useAppBuilderStateContext(): UseAppBuilderStateReturn {
  const ctx = useContext(AppBuilderStateContext);
  if (!ctx) {
    throw new Error(
      "useAppBuilderStateContext must be used inside an AppBuilderStateProvider"
    );
  }
  return ctx;
}
