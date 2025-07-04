/**
 * React hook for managing server configurations in the shared database
 */

import { useState, useEffect, useCallback } from 'react';
import { MCPJamServerConfig } from '@/lib/types/serverTypes';

export interface ServerConfigState {
  serverConfigs: Record<string, MCPJamServerConfig>;
  selectedServerName: string;
  isLoading: boolean;
  error: string | null;
}

export function useServerConfigDatabase() {
  const [state, setState] = useState<ServerConfigState>({
    serverConfigs: {},
    selectedServerName: '',
    isLoading: true,
    error: null,
  });

    // Load server configurations from database
  const loadServerConfigs = useCallback(async () => {
    try {
      setState(prev => ({ ...prev, isLoading: true, error: null }));
      
      // Load from the actual database
      const { libsqlBrowserDatabase: browserDatabase } = await import('../lib/database/browser-database-libsql');
      
      const serverConfigs = await browserDatabase.getAllServerConfigs();
      const selectedServerName = await browserDatabase.getSelectedServer();

      // Set default selected server if none is set
      const finalSelectedServer = selectedServerName && serverConfigs[selectedServerName] 
        ? selectedServerName 
        : Object.keys(serverConfigs).length > 0 
          ? Object.keys(serverConfigs)[0] 
          : '';

      setState(prev => ({
        ...prev,
        serverConfigs,
        selectedServerName: finalSelectedServer,
        isLoading: false,
      }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setState(prev => ({ ...prev, error: errorMessage, isLoading: false }));
      console.error('❌ Failed to load server configurations:', error);
    }
  }, []);

    // Save selected server to database
  const saveSelectedServer = useCallback(async (serverName: string) => {
    try {
      const { libsqlBrowserDatabase: browserDatabase } = await import('../lib/database/browser-database-libsql');
      await browserDatabase.setSelectedServer(serverName);
      setState(prev => ({ ...prev, selectedServerName: serverName }));
    } catch (error) {
      console.error('❌ Failed to save selected server:', error);
    }
  }, []);

  // Update a server configuration
  const updateServerConfig = useCallback(async (serverName: string, config: MCPJamServerConfig) => {
    try {
      const { libsqlBrowserDatabase: browserDatabase } = await import('../lib/database/browser-database-libsql');
      await browserDatabase.updateServerConfig(serverName, config);
      
      // Update local state
      setState(prev => ({
        ...prev,
        serverConfigs: { ...prev.serverConfigs, [serverName]: config }
      }));
    } catch (error) {
      console.error('❌ Failed to update server configuration:', error);
    }
  }, []);

  // Remove a server configuration
  const removeServerConfig = useCallback(async (serverName: string) => {
    try {
      const { libsqlBrowserDatabase: browserDatabase } = await import('../lib/database/browser-database-libsql');
      await browserDatabase.deleteServerConfig(serverName);
      
      // Update local state
      setState(prev => {
        const newConfigs = { ...prev.serverConfigs };
        delete newConfigs[serverName];
        return { ...prev, serverConfigs: newConfigs };
      });
    } catch (error) {
      console.error('❌ Failed to remove server configuration:', error);
    }
  }, []);

  // Load configurations on mount
  useEffect(() => {
    loadServerConfigs();
  }, [loadServerConfigs]);

  return {
    ...state,
    updateServerConfig,
    removeServerConfig,
    setSelectedServer: saveSelectedServer,
    reload: loadServerConfigs,
  };
} 