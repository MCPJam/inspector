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
      
      // For now, we'll load from localStorage as a fallback
      // This will be replaced with actual database operations
      const loadServerConfigsFromStorage = (): Record<string, MCPJamServerConfig> => {
        try {
          const stored = localStorage.getItem('mcpServerConfigs_v1');
          if (stored) {
                       const parsed = JSON.parse(stored) as Record<string, unknown>;
                      return Object.entries(parsed).reduce((acc, [name, config]) => {
             if (config && typeof config === 'object' && 'url' in config && config.url && typeof config.url === 'string') {
               acc[name] = {
                 ...config,
                 url: new URL(config.url),
               } as MCPJamServerConfig;
             } else {
               acc[name] = config as MCPJamServerConfig;
             }
             return acc;
           }, {} as Record<string, MCPJamServerConfig>);
          }
        } catch (error) {
          console.warn('Failed to load server configs from localStorage:', error);
        }
        return {};
      };

      const loadSelectedServerFromStorage = (serverConfigs: Record<string, MCPJamServerConfig>): string => {
        try {
          const stored = localStorage.getItem('selectedServerName_v1');
          if (stored && serverConfigs[stored]) {
            return stored;
          }
        } catch (error) {
          console.warn('Failed to load selected server from localStorage:', error);
        }
        const serverNames = Object.keys(serverConfigs);
        return serverNames.length > 0 ? serverNames[0] : '';
      };

      const serverConfigs = loadServerConfigsFromStorage();
      const selectedServerName = loadSelectedServerFromStorage(serverConfigs);

      setState(prev => ({
        ...prev,
        serverConfigs,
        selectedServerName,
        isLoading: false,
      }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setState(prev => ({ ...prev, error: errorMessage, isLoading: false }));
      console.error('❌ Failed to load server configurations:', error);
    }
  }, []);

  // Save server configurations to database
  const saveServerConfigs = useCallback(async (configs: Record<string, MCPJamServerConfig>) => {
    try {
      // For now, we'll save to localStorage as a fallback
      // This will be replaced with actual database operations
      const serializeServerConfigs = (configs: Record<string, MCPJamServerConfig>): string => {
        const serializable = Object.entries(configs).reduce((acc, [name, config]) => {
          if ('url' in config && config.url) {
            acc[name] = {
              ...config,
              url: config.url.toString(),
            };
          } else {
            acc[name] = config;
          }
          return acc;
                 }, {} as Record<string, unknown>);
        return JSON.stringify(serializable);
      };

      if (Object.keys(configs).length > 0) {
        const serialized = serializeServerConfigs(configs);
        localStorage.setItem('mcpServerConfigs_v1', serialized);
      } else {
        localStorage.removeItem('mcpServerConfigs_v1');
      }

      setState(prev => ({ ...prev, serverConfigs: configs }));
    } catch (error) {
      console.error('❌ Failed to save server configurations:', error);
    }
  }, []);

  // Save selected server to database
  const saveSelectedServer = useCallback(async (serverName: string) => {
    try {
      if (serverName) {
        localStorage.setItem('selectedServerName_v1', serverName);
      } else {
        localStorage.removeItem('selectedServerName_v1');
      }
      setState(prev => ({ ...prev, selectedServerName: serverName }));
    } catch (error) {
      console.error('❌ Failed to save selected server:', error);
    }
  }, []);

  // Update a server configuration
  const updateServerConfig = useCallback(async (serverName: string, config: MCPJamServerConfig) => {
    const newConfigs = { ...state.serverConfigs, [serverName]: config };
    await saveServerConfigs(newConfigs);
  }, [state.serverConfigs, saveServerConfigs]);

  // Remove a server configuration
  const removeServerConfig = useCallback(async (serverName: string) => {
    const newConfigs = { ...state.serverConfigs };
    delete newConfigs[serverName];
    await saveServerConfigs(newConfigs);
  }, [state.serverConfigs, saveServerConfigs]);

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