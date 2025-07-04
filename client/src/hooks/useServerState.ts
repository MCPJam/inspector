import { useState, useCallback } from "react";
import {
  MCPJamServerConfig,
  StdioServerDefinition,
} from "@/lib/types/serverTypes";
import { useServerConfigDatabase } from "./useServerConfigDatabase";

// Legacy localStorage functions removed - now using database hooks

export const useServerState = () => {
  // Use the database hook for server configurations
  const {
    serverConfigs,
    selectedServerName,
    updateServerConfig: dbUpdateServerConfig,
    removeServerConfig: dbRemoveServerConfig,
    setSelectedServer,
    isLoading,
    error,
  } = useServerConfigDatabase();

  // Client form state for creating/editing
  const [isCreatingClient, setIsCreatingClient] = useState(false);
  const [editingClientName, setEditingClientName] = useState<string | null>(
    null,
  );
  const [clientFormConfig, setClientFormConfig] = useState<MCPJamServerConfig>({
    transportType: "stdio",
    command: "npx",
    args: ["@modelcontextprotocol/server-everything"],
    env: {},
  } as StdioServerDefinition);
  const [clientFormName, setClientFormName] = useState("");

  // Use database methods for updating server configurations
  const updateServerConfig = useCallback(
    (serverName: string, config: MCPJamServerConfig) => {
      void dbUpdateServerConfig(serverName, config);
    },
    [dbUpdateServerConfig],
  );

  const removeServerConfig = useCallback((serverName: string) => {
    void dbRemoveServerConfig(serverName);
  }, [dbRemoveServerConfig]);

  const handleCreateClient = useCallback(() => {
    setIsCreatingClient(true);
    setEditingClientName(null);
    setClientFormName("");
    setClientFormConfig({
      transportType: "stdio",
      command: "npx",
      args: ["@modelcontextprotocol/server-everything"],
      env: {},
    } as StdioServerDefinition);
  }, []);

  const handleEditClient = useCallback(
    (serverName: string, config: MCPJamServerConfig) => {
      setIsCreatingClient(false);
      setEditingClientName(serverName);
      setClientFormName(serverName);
      setClientFormConfig(config);
    },
    [],
  );

  const handleCancelClientForm = useCallback(() => {
    setIsCreatingClient(false);
    setEditingClientName(null);
    setClientFormName("");
  }, []);

  return {
    serverConfigs,
    selectedServerName,
    setSelectedServerName: setSelectedServer,
    isCreatingClient,
    editingClientName,
    clientFormConfig,
    setClientFormConfig,
    clientFormName,
    setClientFormName,
    updateServerConfig,
    removeServerConfig,
    handleCreateClient,
    handleEditClient,
    handleCancelClientForm,
    // Database-specific properties
    isLoading,
    error,
  };
};
