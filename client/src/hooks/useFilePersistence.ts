import { useCallback, useEffect, useState } from "react";
import { MCPJamServerConfig } from "@/lib/types/serverTypes";
import { ConnectionPersistenceService } from "@/services/connectionPersistenceService";

export interface FilePersistenceState {
  isLoading: boolean;
  error: string | null;
  lastSaved: Date | null;
  filePath: string | null;
}

export const useFilePersistence = () => {
  const [state, setState] = useState<FilePersistenceState>({
    isLoading: false,
    error: null,
    lastSaved: null,
    filePath: null,
  });

  const setLoading = useCallback((loading: boolean) => {
    setState((prev: FilePersistenceState) => ({ ...prev, isLoading: loading }));
  }, []);

  const setError = useCallback((error: string | null) => {
    setState((prev: FilePersistenceState) => ({ ...prev, error }));
  }, []);

  const setSuccess = useCallback((filePath?: string) => {
    setState((prev: FilePersistenceState) => ({ 
      ...prev, 
      error: null, 
      lastSaved: new Date(),
      filePath: filePath || prev.filePath 
    }));
  }, []);

  /**
   * Load connections from file on startup
   */
  const loadConnectionsFromFile = useCallback(async (): Promise<Record<string, MCPJamServerConfig> | null> => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await ConnectionPersistenceService.loadConnections();
      
      if (response.success) {
        if (response.connections) {
                   setState((prev: FilePersistenceState) => ({ 
           ...prev, 
           filePath: response.filePath || null 
         }));
          return response.connections;
        } else {
          // No file exists yet, which is fine
          return null;
        }
      } else {
        throw new Error(response.error || 'Failed to load connections');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setError(`Failed to load connections: ${errorMessage}`);
      return null;
    } finally {
      setLoading(false);
    }
  }, [setLoading, setError]);

  /**
   * Save connections to file
   */
  const saveConnectionsToFile = useCallback(async (
    connections: Record<string, MCPJamServerConfig>
  ): Promise<boolean> => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await ConnectionPersistenceService.saveConnections(connections);
      
      if (response.success) {
        setSuccess(response.filePath);
        return true;
      } else {
        throw new Error(response.error || 'Failed to save connections');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setError(`Failed to save connections: ${errorMessage}`);
      return false;
    } finally {
      setLoading(false);
    }
  }, [setLoading, setError, setSuccess]);

  /**
   * Export connections as downloadable file
   */
  const exportConnections = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    setError(null);
    
    try {
      await ConnectionPersistenceService.exportConnections();
      setSuccess();
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setError(`Failed to export connections: ${errorMessage}`);
      return false;
    } finally {
      setLoading(false);
    }
  }, [setLoading, setError, setSuccess]);

  /**
   * Import connections from file
   */
  const importConnectionsFromFile = useCallback(async (
    file: File,
    merge: boolean = false
  ): Promise<Record<string, MCPJamServerConfig> | null> => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await ConnectionPersistenceService.importConnectionsFromFile(file, merge);
      
      if (response.success) {
        setSuccess(response.filePath);
        // Load the updated connections
        return await loadConnectionsFromFile();
      } else {
        throw new Error(response.error || 'Failed to import connections');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setError(`Failed to import connections: ${errorMessage}`);
      return null;
    } finally {
      setLoading(false);
    }
  }, [setLoading, setError, setSuccess, loadConnectionsFromFile]);

  /**
   * Clear error state
   */
  const clearError = useCallback(() => {
    setError(null);
  }, [setError]);

  return {
    state,
    loadConnectionsFromFile,
    saveConnectionsToFile,
    exportConnections,
    importConnectionsFromFile,
    clearError,
  };
};