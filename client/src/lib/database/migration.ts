/**
 * Migration utility to move data from localStorage to the shared database
 */

// Switch to HTTP-based database client for browser compatibility and shared database access
// import { libsqlBrowserDatabase as browserDatabase } from './browser-database-libsql';
import { httpBrowserDatabase as browserDatabase } from './browser-database-http';
import { MCPJamServerConfig } from '@/lib/types/serverTypes';
import { McpJamRequest } from '@/lib/types/requestTypes';

export interface MigrationResult {
  success: boolean;
  migratedCounts: {
    serverConfigs: number;
    requestHistory: number;
    userPreferences: boolean;
  };
  errors: string[];
}

export class DatabaseMigrator {
  private database = browserDatabase;

  async isMigrationNeeded(): Promise<boolean> {
    try {
      // Check if there's data in localStorage that needs to be migrated
      const hasServerConfigs = localStorage.getItem('mcpServerConfigs_v1') !== null;
      const hasRequests = localStorage.getItem('mcpjam_saved_requests') !== null;
      const hasTheme = localStorage.getItem('theme') !== null;
      const hasStarModal = localStorage.getItem('hasSeenStarModal') !== null;

      return hasServerConfigs || hasRequests || hasTheme || hasStarModal;
    } catch (error) {
      console.warn('Failed to check migration status:', error);
      return false;
    }
  }

  async performFullMigration(): Promise<MigrationResult> {
    const result: MigrationResult = {
      success: true,
      migratedCounts: {
        serverConfigs: 0,
        requestHistory: 0,
        userPreferences: false,
      },
      errors: [],
    };

    try {
      // Migrate server configurations
      const serverConfigsCount = await this.migrateServerConfigs();
      result.migratedCounts.serverConfigs = serverConfigsCount;

      // Migrate request history
      const requestHistoryCount = await this.migrateRequestHistory();
      result.migratedCounts.requestHistory = requestHistoryCount;

      // Migrate user preferences
      const userPreferencesMigrated = await this.migrateUserPreferences();
      result.migratedCounts.userPreferences = userPreferencesMigrated;

      console.log('✅ Migration completed successfully', result.migratedCounts);
    } catch (error) {
      result.success = false;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      result.errors.push(errorMessage);
      console.error('❌ Migration failed:', error);
    }

    return result;
  }

  private async migrateServerConfigs(): Promise<number> {
    try {
      const stored = localStorage.getItem('mcpServerConfigs_v1');
      if (!stored) return 0;

      const parsed = JSON.parse(stored) as Record<string, unknown>;
      let count = 0;

      for (const [name, config] of Object.entries(parsed)) {
        if (config && typeof config === 'object') {
          const serverConfig = this.deserializeServerConfig(config);
          await this.database.updateServerConfig(name, serverConfig);
          count++;
        }
      }

      // Migrate selected server
      const selectedServer = localStorage.getItem('selectedServerName_v1');
      if (selectedServer) {
        await this.database.setSelectedServer(selectedServer);
      }

      return count;
    } catch (error) {
      console.warn('Failed to migrate server configs:', error);
      return 0;
    }
  }

  private async migrateRequestHistory(): Promise<number> {
    try {
      const stored = localStorage.getItem('mcpjam_saved_requests');
      if (!stored) return 0;

      const data = JSON.parse(stored);
      const requests = data.requests || [];
      let count = 0;

      for (const request of requests) {
        const mcpRequest = this.deserializeRequest(request);
        await this.database.addRequestHistory(mcpRequest);
        count++;
      }

      return count;
    } catch (error) {
      console.warn('Failed to migrate request history:', error);
      return 0;
    }
  }

  private async migrateUserPreferences(): Promise<boolean> {
    try {
      const preferences: Record<string, unknown> = {};

      // Migrate theme
      const theme = localStorage.getItem('theme');
      if (theme) {
        preferences.theme = theme;
      }

      // Migrate star modal state
      const hasSeenStarModal = localStorage.getItem('hasSeenStarModal');
      if (hasSeenStarModal) {
        preferences.hasSeenStarModal = hasSeenStarModal === 'true';
      }

      // Migrate auto-open setting
      const autoOpenEnabled = localStorage.getItem('MCP_AUTO_OPEN_ENABLED');
      if (autoOpenEnabled !== null) {
        preferences.autoOpenEnabled = autoOpenEnabled !== 'false';
      }

      // Migrate pane heights
      const paneHeights: Record<string, number> = {};
      for (const key of ['leftPanelHeight', 'rightPanelHeight', 'bottomPanelHeight']) {
        const stored = localStorage.getItem(key);
        if (stored) {
          const height = parseInt(stored, 10);
          if (!isNaN(height)) {
            paneHeights[key] = height;
          }
        }
      }
      if (Object.keys(paneHeights).length > 0) {
        preferences.paneHeights = paneHeights;
      }

      if (Object.keys(preferences).length > 0) {
        await this.database.updateUserPreferences(preferences);
        return true;
      }

      return false;
    } catch (error) {
      console.warn('Failed to migrate user preferences:', error);
      return false;
    }
  }

  private deserializeServerConfig(config: unknown): MCPJamServerConfig {
    if (!config || typeof config !== 'object') {
      throw new Error('Invalid server config format');
    }

    const obj = config as Record<string, unknown>;
    
    // Convert URL string back to URL object if needed
    if ('url' in obj && obj.url && typeof obj.url === 'string') {
      return {
        ...obj,
        url: new URL(obj.url),
      } as MCPJamServerConfig;
    }

    return obj as MCPJamServerConfig;
  }

  private deserializeRequest(request: unknown): McpJamRequest {
    if (!request || typeof request !== 'object') {
      throw new Error('Invalid request format');
    }

    const obj = request as Record<string, unknown>;
    
    // Convert date strings back to Date objects
    return {
      ...obj,
      createdAt: obj.createdAt ? new Date(obj.createdAt as string) : new Date(),
      updatedAt: obj.updatedAt ? new Date(obj.updatedAt as string) : new Date(),
    } as McpJamRequest;
  }

  clearLocalStorage(): void {
    try {
      // Clear migrated localStorage items
      const keysToRemove = [
        // Server configuration data
        'mcpServerConfigs_v1',
        'selectedServerName_v1',
        'selected-provider',
        
        // Request history data
        'mcpjam_saved_requests',
        
        // User preferences
        'theme',
        'hasSeenStarModal',
        'MCP_AUTO_OPEN_ENABLED',
        
        // Panel heights
        'leftPanelHeight',
        'rightPanelHeight',
        'bottomPanelHeight',
        'historyPaneHeight',
        
        // Inspector configuration
        'inspectorConfig_v1',
        
        // Form state
        'lastArgs',
        'lastBearerToken',
        'lastCommand',
        'lastHeaderName',
        'lastSseUrl',
        'lastTransportType',
        
        // Provider API keys
        'openai-api-key',
        'anthropic-api-key',
        'ollama-api-key',
      ];

      for (const key of keysToRemove) {
        localStorage.removeItem(key);
      }

      console.log('🧹 Cleared migrated localStorage data');
    } catch (error) {
      console.warn('Failed to clear localStorage:', error);
    }
  }
}

export const migrator = new DatabaseMigrator(); 