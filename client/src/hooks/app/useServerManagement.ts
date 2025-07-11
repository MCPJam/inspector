import { useCallback } from "react";
import {
  CreateMessageRequest,
  CreateMessageResult,
  ElicitRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { StdErrNotification } from "../../lib/types/notificationTypes";
import { MCPJamServerConfig } from "../../lib/types/serverTypes";
import { useServerState } from "../useServerState";
import { useConnectionState } from "../useConnectionState";
import { useConfigState } from "../useConfigState";
import { useMCPOperations } from "../useMCPOperations";

// Import ElicitationResponse from the modal component
import { ElicitationResponse } from "../../components/ElicitationModal";

// Server Management Hook
export const useServerManagement = (
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
) => {
  const { addClientLog } = mcpOperations;

  const handleAddServer = useCallback(
    async (
      name: string,
      serverConfig: MCPJamServerConfig,
      options: { autoConnect?: boolean } = {},
    ) => {
      console.log("🔧 Adding server with options:", {
        name,
        serverConfig,
        options,
      });

      const shouldSelectNewServer =
        Object.keys(serverState.serverConfigs).length === 0;

      serverState.updateServerConfig(name, serverConfig);

      if (shouldSelectNewServer) {
        serverState.setSelectedServerName(name);
      }

      if (!connectionState.mcpAgent) {
        console.log("🆕 Creating agent with server config...");
        addClientLog(
          `🆕 Creating agent with server config (no auto-connect) ${name} ${JSON.stringify(serverConfig)}`,
          "info",
        );
        try {
          const allServerConfigs = {
            ...serverState.serverConfigs,
            [name]: serverConfig,
          };

          const agent = await connectionState.createAgentWithoutConnecting(
            allServerConfigs,
            configState.config,
            configState.bearerToken,
            configState.headerName,
            onStdErrNotification,
            onPendingRequest,
            getRootsCallback,
            onElicitationRequest,
          );
          if (options.autoConnect) {
            console.log("🔌 Auto-connecting to all servers...");
            await agent.connectToAllServers();
            console.log("✅ Successfully connected to all servers");
            serverState.setSelectedServerName(name);
            connectionState.forceUpdateSidebar();
          }
        } catch (error) {
          console.error("❌ Failed to create agent and connect:", error);
          throw error;
        }
      } else {
        connectionState.mcpAgent.addServer(name, serverConfig);
        connectionState.forceUpdateSidebar();

        if (options.autoConnect) {
          console.log(`🔌 Auto-connecting to server: "${name}"`);
          try {
            serverState.setSelectedServerName(name);
            await connectionState.connectServer(name);
            console.log(`✅ Successfully auto-connected to "${name}"`);
          } catch (error) {
            console.error(`❌ Failed to auto-connect to "${name}":`, error);
          }
        }
      }

      return name;
    },
    [
      serverState,
      connectionState,
      configState,
      onStdErrNotification,
      onPendingRequest,
      onElicitationRequest,
      getRootsCallback,
      addClientLog,
    ],
  );

  const handleRemoveServer = useCallback(
    async (serverName: string) => {
      await connectionState.removeServer(serverName);
      serverState.removeServerConfig(serverName);

      if (serverState.selectedServerName === serverName) {
        const remainingServers = Object.keys(serverState.serverConfigs).filter(
          (name) => name !== serverName,
        );
        serverState.setSelectedServerName(
          remainingServers.length > 0 ? remainingServers[0] : "",
        );
      }
    },
    [connectionState, serverState],
  );

  const handleUpdateServer = useCallback(
    async (serverName: string, config: MCPJamServerConfig) => {
      await connectionState.updateServer(serverName, config);
      serverState.updateServerConfig(serverName, config);
      addClientLog(
        `🔧 Updated server: ${serverName} ${JSON.stringify(config)}`,
        "info",
      );
    },
    [connectionState, serverState, addClientLog],
  );

  const handleEditClient = useCallback(
    (serverName: string) => {
      const serverConnections = connectionState.mcpAgent
        ? connectionState.mcpAgent.getAllConnectionInfo()
        : [];
      const connection = serverConnections.find(
        (conn) => conn.name === serverName,
      );
      if (!connection) return;

      serverState.handleEditClient(serverName, connection.config);
    },
    [connectionState.mcpAgent, serverState],
  );

  const handleConnectServer = useCallback(
    async (serverName: string) => {
      await connectionState.connectServer(serverName);
    },
    [connectionState],
  );

  const saveClients = useCallback(
    async (clients: Array<{ name: string; config: MCPJamServerConfig }>) => {
      const results: {
        success: string[];
        failed: Array<{ name: string; error: string }>;
      } = {
        success: [],
        failed: [],
      };

      for (const client of clients) {
        try {
          // Handle single client editing case
          if (serverState.editingClientName && clients.length === 1) {
            const oldServerName = serverState.editingClientName;
            const newServerName = client.name.trim();

            if (oldServerName !== newServerName) {
              addClientLog(
                `🔄 Server name changed from "${oldServerName}" to "${newServerName}"`,
                "info",
              );

              await handleRemoveServer(oldServerName);
              await handleAddServer(newServerName, client.config, {
                autoConnect: true,
              });

              if (serverState.selectedServerName === oldServerName) {
                serverState.setSelectedServerName(newServerName);
              }
            } else {
              await handleUpdateServer(
                serverState.editingClientName,
                client.config,
              );
            }
          } else {
            // Handle creating new clients (single or multiple)
            console.log(`🔧 Creating client: "${client.name}"`);
            await handleAddServer(client.name, client.config, {
              autoConnect: clients.length === 1, // Auto-connect only for single client
            });
          }

          results.success.push(client.name);
          addClientLog(
            `✅ Successfully ${serverState.editingClientName ? "updated" : "created"} client: "${client.name}"`,
            "info",
          );
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          addClientLog(
            `❌ Failed to ${serverState.editingClientName ? "update" : "create"} client "${client.name}": ${errorMessage}`,
            "error",
          );
          results.failed.push({ name: client.name, error: errorMessage });
        }
      }

      serverState.handleCancelClientForm();

      if (results.success.length > 0) {
        addClientLog(
          `✅ Successfully ${serverState.editingClientName ? "updated" : "created"} ${results.success.length} client(s): ${results.success.join(", ")}`,
          "info",
        );
      }

      if (results.failed.length > 0) {
        addClientLog(
          `❌ Failed to ${serverState.editingClientName ? "update" : "create"} ${results.failed.length} client(s): ${results.failed.map(({ name, error }) => `${name}: ${error}`).join(", ")}`,
          "error",
        );
      }

      return results;
    },
    [
      handleAddServer,
      handleUpdateServer,
      handleRemoveServer,
      serverState,
      addClientLog,
    ],
  );

  return {
    handleAddServer,
    handleRemoveServer,
    handleUpdateServer,
    handleEditClient,
    handleConnectServer,
    saveClients,
  };
};
