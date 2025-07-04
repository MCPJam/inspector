import { useEffect } from "react";
import {
  CreateMessageRequest,
  CreateMessageResult,
  ElicitRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { StdErrNotification } from "../../lib/types/notificationTypes";
import { StdioServerDefinition } from "../../lib/types/serverTypes";
import { loadOAuthTokens } from "../../services/oauth";
import { getMCPProxyAddressAsync } from "../../lib/utils/json/configUtils";
import { useServerState } from "../useServerState";
import { useConnectionState } from "../useConnectionState";
import { useConfigState } from "../useConfigState";
import { useMCPOperations } from "../useMCPOperations";
import { ElicitationResponse } from "../../components/ElicitationModal";

// Additional Effect Hooks Helper
export const useAppEffects = (
  serverState: ReturnType<typeof useServerState>,
  connectionState: ReturnType<typeof useConnectionState>,
  configState: ReturnType<typeof useConfigState>,
  mcpOperations: ReturnType<typeof useMCPOperations>,
  onStdErrNotification: (notification: StdErrNotification) => void,
  onPendingRequest: (
    request: CreateMessageRequest,
    resolve: (result: CreateMessageResult) => void,
    reject: (error: Error) => void,
  ) => void,
  onElicitationRequest: (
    request: ElicitRequest,
    resolve: (result: ElicitationResponse) => void,
  ) => void,
  getRootsCallback: () => {
    [x: string]: unknown;
    uri: string;
    _meta?: { [x: string]: unknown } | undefined;
    name?: string | undefined;
  }[],
  rootsRef: React.MutableRefObject<
    {
      [x: string]: unknown;
      uri: string;
      _meta?: { [x: string]: unknown } | undefined;
      name?: string | undefined;
    }[]
  >,
  addClientLog: (message: string, level: "info" | "warn" | "error") => void,
) => {
  // Effect to sync roots ref
  useEffect(() => {
    rootsRef.current = mcpOperations.roots;
  }, [mcpOperations.roots, rootsRef]);

  // Effect to restore agent with saved server configs (without connecting)
  useEffect(() => {
    const restoreAgentWithoutConnecting = async () => {
      if (window.location.pathname.startsWith("/oauth/callback")) {
        return;
      }
      if (
        Object.keys(serverState.serverConfigs).length > 0 &&
        !connectionState.mcpAgent
      ) {
        try {
          await connectionState.createAgentWithoutConnecting(
            serverState.serverConfigs,
            configState.config,
            configState.bearerToken,
            configState.headerName,
            onStdErrNotification,
            onPendingRequest,
            getRootsCallback,
            onElicitationRequest,
          );
        } catch (error) {
          addClientLog(
            `❌ Failed to restore agent: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
      }
    };

    restoreAgentWithoutConnecting();
  }, [
    serverState.serverConfigs,
    connectionState,
    configState.config,
    configState.bearerToken,
    configState.headerName,
    onStdErrNotification,
    onPendingRequest,
    onElicitationRequest,
    getRootsCallback,
    addClientLog,
  ]);

  // Load OAuth tokens when sseUrl changes
  useEffect(() => {
    const loadTokens = async () => {
      const currentConfig =
        serverState.serverConfigs[serverState.selectedServerName];
      if (currentConfig && "url" in currentConfig && currentConfig.url) {
        await loadOAuthTokens(
          currentConfig.url.toString(),
          configState.updateAuthState,
        );
      }
    };

    loadTokens();
  }, [
    serverState.selectedServerName,
    serverState.serverConfigs,
    configState.updateAuthState,
  ]);

  // Fetch default environment
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const proxyAddress = await getMCPProxyAddressAsync(configState.config);
        const response = await fetch(`${proxyAddress}/config`);
        const data = await response.json();
        const currentConfig =
          serverState.serverConfigs[serverState.selectedServerName];
        if (currentConfig?.transportType === "stdio") {
          void serverState.updateServerConfig(serverState.selectedServerName, {
            ...currentConfig,
            env: data.defaultEnvironment || {},
          } as StdioServerDefinition);
        }
      } catch (error) {
        console.error("Error fetching default environment:", error);
      }
    };

    fetchConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
};
