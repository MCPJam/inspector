import {
  useCallback,
  useReducer,
  useRef,
  useMemo,
  type ReactNode,
} from "react";
import {
  AppStateProvider,
  useSharedAppState,
  type AppRuntimeContextValue,
} from "./app-state-context";
import { appReducer } from "./app-reducer";
import type { AppState, ServerWithName } from "./app-types";
import {
  testRuntimeServerConnection,
  deleteServer,
  getInitializationInfo,
} from "./mcp-api";
import { HOSTED_MODE } from "@/lib/config";
import {
  registerRuntimeServerConfig,
  unregisterRuntimeServerConfig,
} from "@/lib/apis/web/context";

const LEARNING_WORKSPACE_ID = "learning";

function buildInitialLearningState(parentState: AppState): AppState {
  const parentWorkspace = parentState.workspaces[parentState.activeWorkspaceId];
  return {
    workspaces: {
      [LEARNING_WORKSPACE_ID]: {
        id: LEARNING_WORKSPACE_ID,
        name: "Learning",
        description: "Interactive learning sandbox",
        servers: {},
        clientConfig: parentWorkspace?.clientConfig,
        createdAt: new Date(),
        updatedAt: new Date(),
        isDefault: false,
      },
    },
    activeWorkspaceId: LEARNING_WORKSPACE_ID,
    servers: {},
    selectedServer: "none",
    selectedMultipleServers: [],
    isMultiSelectMode: false,
  };
}

/**
 * Provides an isolated AppState + runtime API for the learning sandbox.
 *
 * Reads the parent workspace's client config, creates a synthetic "learning"
 * workspace with its own `useReducer(appReducer, ...)`, and exposes a runtime
 * API for connecting/disconnecting the learning server.
 */
export function LearningStateProvider({ children }: { children: ReactNode }) {
  const parentState = useSharedAppState();
  const [state, dispatch] = useReducer(
    appReducer,
    parentState,
    buildInitialLearningState,
  );

  // Per-server op tokens so stale async results are ignored after reconnect/unmount.
  const opTokenRef = useRef(0);

  const connectRuntimeServer: AppRuntimeContextValue["connectRuntimeServer"] =
    useCallback(async ({ name, config, silent }) => {
      const token = ++opTokenRef.current;

      dispatch({
        type: "CONNECT_REQUEST",
        name,
        config,
        select: true,
      });

      // In hosted mode, register the config so buildHostedServerRequest can resolve it.
      if (HOSTED_MODE) {
        registerRuntimeServerConfig(name, config);
      }

      try {
        const result = await testRuntimeServerConnection(config, name);

        // Stale — a newer op has started.
        if (opTokenRef.current !== token) return;

        if (result.success === false) {
          dispatch({
            type: "CONNECT_FAILURE",
            name,
            error: result.error ?? "Connection failed",
          });
          if (!silent) {
            console.warn(
              `[LearningStateProvider] connect failed for ${name}:`,
              result.error,
            );
          }
          return;
        }

        dispatch({
          type: "CONNECT_SUCCESS",
          name,
          config,
        });

        // Store initialization info if returned inline.
        if (result.initInfo) {
          dispatch({
            type: "SET_INITIALIZATION_INFO",
            name,
            initInfo: result.initInfo,
          });
        } else {
          // Fallback fetch for local mode.
          try {
            const infoRes = await getInitializationInfo(name);
            if (opTokenRef.current === token && infoRes.initInfo) {
              dispatch({
                type: "SET_INITIALIZATION_INFO",
                name,
                initInfo: infoRes.initInfo,
              });
            }
          } catch {
            // Non-critical — init info is optional.
          }
        }
      } catch (err) {
        if (opTokenRef.current !== token) return;
        const msg =
          err instanceof Error ? err.message : "Unknown connection error";
        dispatch({ type: "CONNECT_FAILURE", name, error: msg });
        if (!silent) {
          console.warn(
            `[LearningStateProvider] connect error for ${name}:`,
            msg,
          );
        }
      }
    }, []);

  const disconnectRuntimeServer: AppRuntimeContextValue["disconnectRuntimeServer"] =
    useCallback(async (name: string) => {
      ++opTokenRef.current; // Invalidate any in-flight ops for this server.

      dispatch({ type: "REMOVE_SERVER", name });

      if (HOSTED_MODE) {
        unregisterRuntimeServerConfig(name);
      } else {
        try {
          await deleteServer(name);
        } catch {
          // Best-effort cleanup in local mode.
        }
      }
    }, []);

  const getServerEntry: AppRuntimeContextValue["getServerEntry"] = useCallback(
    (name: string): ServerWithName | undefined => {
      return state.servers[name];
    },
    [state.servers],
  );

  const runtimeApi: AppRuntimeContextValue = useMemo(
    () => ({
      connectRuntimeServer,
      disconnectRuntimeServer,
      getServerEntry,
    }),
    [connectRuntimeServer, disconnectRuntimeServer, getServerEntry],
  );

  return (
    <AppStateProvider appState={state} runtimeApi={runtimeApi}>
      {children}
    </AppStateProvider>
  );
}
