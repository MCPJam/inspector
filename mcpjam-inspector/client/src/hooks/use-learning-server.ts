import { useCallback, useEffect, useMemo } from "react";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import type { ServerWithName } from "@/state/app-types";
import {
  useSharedAppRuntime,
  useSharedAppState,
} from "@/state/app-state-context";

export const LEARNING_SERVER_ID = "__learning__";
export const DEFAULT_LEARNING_SERVER_URL =
  import.meta.env.VITE_LEARNING_SERVER_URL ?? "https://learn.mcpjam.com/mcp";

export interface UseLearningServerOptions {
  autoConnect?: boolean;
  disconnectOnUnmount?: boolean;
  silent?: boolean;
  serverId?: string;
  serverUrl?: string;
}

export interface LearningServerHandle {
  serverId: string;
  serverConfig: MCPServerConfig;
  serverEntry?: ServerWithName;
  initInfo?: ServerWithName["initializationInfo"];
  status: ServerWithName["connectionStatus"] | "disconnected";
  error?: string;
  isConnected: boolean;
  isConnecting: boolean;
  connect: () => Promise<void>;
  reconnect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

export function useLearningServer({
  autoConnect = true,
  disconnectOnUnmount = true,
  silent = true,
  serverId = LEARNING_SERVER_ID,
  serverUrl = DEFAULT_LEARNING_SERVER_URL,
}: UseLearningServerOptions = {}): LearningServerHandle {
  const appState = useSharedAppState();
  const { connectRuntimeServer, disconnectRuntimeServer, getServerEntry } =
    useSharedAppRuntime();

  const serverConfig = useMemo<MCPServerConfig>(
    () => ({
      url: serverUrl,
    }),
    [serverUrl],
  );
  const serverEntry = appState.servers[serverId] ?? getServerEntry(serverId);
  const status = serverEntry?.connectionStatus ?? "disconnected";

  const connect = useCallback(
    () =>
      connectRuntimeServer({
        name: serverId,
        config: serverConfig,
        surface: "learning",
        silent,
        select: false,
      }),
    [connectRuntimeServer, serverConfig, serverId, silent],
  );

  const disconnect = useCallback(
    () => disconnectRuntimeServer(serverId),
    [disconnectRuntimeServer, serverId],
  );

  const reconnect = useCallback(async () => {
    if (serverEntry?.connectionStatus === "connected") {
      await connect();
      return;
    }

    if (serverEntry) {
      await disconnect();
    }
    await connect();
  }, [connect, disconnect, serverEntry]);

  useEffect(() => {
    if (!autoConnect) {
      return;
    }

    if (status === "connected" || status === "connecting") {
      return;
    }

    void connect();
  }, [autoConnect, connect, status]);

  useEffect(
    () => () => {
      if (!disconnectOnUnmount) {
        return;
      }

      void disconnect();
    },
    [disconnect, disconnectOnUnmount],
  );

  return {
    serverId,
    serverConfig,
    serverEntry,
    initInfo: serverEntry?.initializationInfo,
    status,
    error: serverEntry?.lastError,
    isConnected: status === "connected",
    isConnecting: status === "connecting",
    connect,
    reconnect,
    disconnect,
  };
}
