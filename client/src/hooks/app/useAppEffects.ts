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

  // Fetch default environment and handle CLI server configs
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const proxyAddress = await getMCPProxyAddressAsync(configState.config);
        const response = await fetch(`${proxyAddress}/config`);
        const data = await response.json();

        // Handle CLI-provided server configurations
        if (data.serverConfigs && Object.keys(data.serverConfigs).length > 0) {
          console.log("📡 Found CLI server configurations, loading...");

          // Convert CLI config format to internal format
          const convertedConfigs: Record<string, any> = {};

          for (const [serverName, cliConfig] of Object.entries(
            data.serverConfigs,
          )) {
            const config = cliConfig as any;

            // Convert different transport types
            if (config.type === "sse" && config.url) {
              // SSE configuration
              convertedConfigs[serverName] = {
                transportType: "sse",
                url: new URL(config.url),
                name: serverName,
              };
            } else if (config.command) {
              // STDIO configuration
              convertedConfigs[serverName] = {
                transportType: "stdio",
                command: config.command,
                args: config.args || [],
                env: {
                  ...(data.defaultEnvironment || {}),
                  ...(config.env || {}),
                },
                name: serverName,
              };
            } else if (config.url) {
              // Default to SSE for URL-based configs
              convertedConfigs[serverName] = {
                transportType: "sse",
                url: new URL(config.url),
                name: serverName,
              };
            }
          }

          // Merge CLI configs with existing localStorage configs
          if (Object.keys(convertedConfigs).length > 0) {
            const existingConfigs = serverState.serverConfigs;
            const hasExistingConfigs = Object.keys(existingConfigs).length > 0;

            // Merge configs: localStorage servers take priority for conflicts
            const mergedConfigs = { ...convertedConfigs, ...existingConfigs };

            console.log(
              `✅ Loading ${Object.keys(convertedConfigs).length} servers from CLI config`,
            );
            if (hasExistingConfigs) {
              console.log(
                `📦 Merging with ${Object.keys(existingConfigs).length} existing localStorage servers`,
              );
            }

            serverState.setServerConfigs(mergedConfigs);

            // Set the first CLI server as selected if no server is currently selected
            if (
              !serverState.selectedServerName ||
              !mergedConfigs[serverState.selectedServerName]
            ) {
              const firstServerName = Object.keys(convertedConfigs)[0];
              serverState.setSelectedServerName(firstServerName);
            }

            const totalServers = Object.keys(mergedConfigs).length;
            const cliServers = Object.keys(convertedConfigs).length;
            addClientLog(
              `Loaded ${cliServers} servers from CLI configuration (${totalServers} total)`,
              "info",
            );
          }
        } else {
          // Handle single server environment update (existing behavior)
          const currentConfig =
            serverState.serverConfigs[serverState.selectedServerName];
          if (currentConfig?.transportType === "stdio") {
            serverState.setServerConfigs((prev) => ({
              ...prev,
              [serverState.selectedServerName]: {
                ...prev[serverState.selectedServerName],
                env: data.defaultEnvironment || {},
              } as StdioServerDefinition,
            }));
          }
        }
      } catch (error) {
        console.error("Error fetching default environment:", error);
      }
    };

    fetchConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
};
