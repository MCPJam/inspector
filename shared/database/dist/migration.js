/**
 * Migration utility to move data from localStorage to the shared database
 * This should be run when users upgrade from localStorage-based storage to the shared database
 */
import { MCPJamDatabase } from "./database";
export class DatabaseMigrator {
    constructor(database) {
        this.database = database;
    }
    /**
     * Extract data from localStorage (browser environment only)
     */
    extractLocalStorageData() {
        if (typeof localStorage === 'undefined') {
            return null;
        }
        const data = {};
        try {
            // Extract server configurations
            const serverConfigsStr = localStorage.getItem('mcpServerConfigs_v1');
            if (serverConfigsStr) {
                data.serverConfigs = JSON.parse(serverConfigsStr);
            }
            // Extract selected server
            const selectedServerStr = localStorage.getItem('selectedServerName_v1');
            if (selectedServerStr) {
                data.selectedServer = selectedServerStr;
            }
            // Extract request history
            const requestHistoryStr = localStorage.getItem('mcpjam_saved_requests');
            if (requestHistoryStr) {
                const requestCollection = JSON.parse(requestHistoryStr);
                data.requestHistory = requestCollection.requests || [];
            }
            // Extract user preferences
            const theme = localStorage.getItem('theme');
            const hasSeenStarModal = localStorage.getItem('hasSeenStarModal');
            if (theme || hasSeenStarModal) {
                data.userPreferences = {
                    theme: theme || 'system',
                    hasSeenStarModal: hasSeenStarModal === 'true'
                };
            }
            // Extract provider configurations
            const providerData = {};
            for (const providerType of ['openai', 'anthropic', 'ollama']) {
                const configStr = localStorage.getItem(`${providerType}_config`);
                if (configStr) {
                    providerData[providerType] = JSON.parse(configStr);
                }
            }
            if (Object.keys(providerData).length > 0) {
                data.providerConfigs = providerData;
            }
            // Extract session data
            const sessionData = {};
            const sessionKeys = [
                'lastCommand', 'lastArgs', 'lastSseUrl', 'lastTransportType',
                'lastBearerToken', 'lastHeaderName'
            ];
            for (const key of sessionKeys) {
                const value = localStorage.getItem(key);
                if (value) {
                    sessionData[key] = value;
                }
            }
            if (Object.keys(sessionData).length > 0) {
                data.sessionData = sessionData;
            }
            // Extract app settings
            const appSettingsData = {};
            const configStr = localStorage.getItem('inspector_config');
            if (configStr) {
                const config = JSON.parse(configStr);
                // Convert config object to app settings format
                for (const [key, configItem] of Object.entries(config)) {
                    if (configItem && typeof configItem === 'object' && 'value' in configItem) {
                        appSettingsData[key] = configItem;
                    }
                }
            }
            if (Object.keys(appSettingsData).length > 0) {
                data.appSettings = appSettingsData;
            }
            return data;
        }
        catch (error) {
            console.error('Failed to extract localStorage data:', error);
            return null;
        }
    }
    /**
     * Migrate data from localStorage format to the shared database
     */
    async migrateData(data) {
        await this.database.initialize();
        const result = {
            success: true,
            migratedCounts: {
                serverConfigs: 0,
                requestHistory: 0,
                providerConfigs: 0,
                userPreferences: 0,
                appSettings: 0,
                sessions: 0,
            },
            errors: [],
        };
        // Migrate server configurations
        if (data.serverConfigs) {
            try {
                const serverIdMap = new Map();
                for (const [name, config] of Object.entries(data.serverConfigs)) {
                    try {
                        const serverConfig = this.convertToServerConfig(name, config);
                        const created = await this.database.createServerConfig(serverConfig);
                        serverIdMap.set(name, created.id);
                        result.migratedCounts.serverConfigs++;
                    }
                    catch (error) {
                        result.errors.push(`Failed to migrate server config '${name}': ${error}`);
                    }
                }
                // Migrate request history with proper client IDs
                if (data.requestHistory) {
                    for (const request of data.requestHistory) {
                        try {
                            const requestConfig = this.convertToRequestHistory(request, serverIdMap);
                            if (requestConfig) {
                                await this.database.createRequestHistory(requestConfig);
                                result.migratedCounts.requestHistory++;
                            }
                        }
                        catch (error) {
                            result.errors.push(`Failed to migrate request '${request.name}': ${error}`);
                        }
                    }
                }
                // Create session with selected server
                if (data.selectedServer && serverIdMap.has(data.selectedServer)) {
                    try {
                        await this.database.createSession({
                            sessionType: 'ui',
                            selectedServerId: serverIdMap.get(data.selectedServer),
                            ...data.sessionData,
                        });
                        result.migratedCounts.sessions++;
                    }
                    catch (error) {
                        result.errors.push(`Failed to migrate session: ${error}`);
                    }
                }
            }
            catch (error) {
                result.errors.push(`Failed to migrate server configurations: ${error}`);
            }
        }
        // Migrate user preferences
        if (data.userPreferences) {
            try {
                const prefs = this.convertToUserPreferences(data.userPreferences);
                await this.database.updateUserPreferences(prefs);
                result.migratedCounts.userPreferences++;
            }
            catch (error) {
                result.errors.push(`Failed to migrate user preferences: ${error}`);
            }
        }
        // Migrate provider configurations
        if (data.providerConfigs) {
            for (const [providerType, config] of Object.entries(data.providerConfigs)) {
                try {
                    const providerConfig = this.convertToProviderConfig(providerType, config);
                    await this.database.createProviderConfig(providerConfig);
                    result.migratedCounts.providerConfigs++;
                }
                catch (error) {
                    result.errors.push(`Failed to migrate provider config '${providerType}': ${error}`);
                }
            }
        }
        // Migrate app settings
        if (data.appSettings) {
            for (const [key, setting] of Object.entries(data.appSettings)) {
                try {
                    const { value, description } = setting;
                    const valueType = typeof value === 'string' ? 'string' :
                        typeof value === 'number' ? 'number' :
                            typeof value === 'boolean' ? 'boolean' : 'json';
                    await this.database.setAppSetting(key, String(value), valueType, description);
                    result.migratedCounts.appSettings++;
                }
                catch (error) {
                    result.errors.push(`Failed to migrate app setting '${key}': ${error}`);
                }
            }
        }
        result.success = result.errors.length === 0;
        return result;
    }
    /**
     * Perform a full migration from localStorage to database
     */
    async performFullMigration() {
        const data = this.extractLocalStorageData();
        if (!data) {
            return {
                success: false,
                migratedCounts: {
                    serverConfigs: 0,
                    requestHistory: 0,
                    providerConfigs: 0,
                    userPreferences: 0,
                    appSettings: 0,
                    sessions: 0,
                },
                errors: ['localStorage is not available or contains no data'],
            };
        }
        return this.migrateData(data);
    }
    /**
     * Check if migration is needed (localStorage has data but database is empty)
     */
    async isMigrationNeeded() {
        const localData = this.extractLocalStorageData();
        if (!localData)
            return false;
        // Check if there's any data in localStorage
        const hasLocalData = !!(localData.serverConfigs && Object.keys(localData.serverConfigs).length > 0 ||
            localData.requestHistory && localData.requestHistory.length > 0 ||
            localData.providerConfigs && Object.keys(localData.providerConfigs).length > 0 ||
            localData.userPreferences ||
            localData.appSettings && Object.keys(localData.appSettings).length > 0);
        if (!hasLocalData)
            return false;
        // Check if database is empty
        try {
            await this.database.initialize();
            const serverConfigs = await this.database.getAllServerConfigs();
            return serverConfigs.length === 0;
        }
        catch (error) {
            console.error('Failed to check database state:', error);
            return false;
        }
    }
    /**
     * Clear localStorage after successful migration
     */
    clearLocalStorage() {
        if (typeof localStorage === 'undefined')
            return;
        const keysToRemove = [
            'mcpServerConfigs_v1',
            'selectedServerName_v1',
            'mcpjam_saved_requests',
            'theme',
            'hasSeenStarModal',
            'openai_config',
            'anthropic_config',
            'ollama_config',
            'inspector_config',
            'lastCommand',
            'lastArgs',
            'lastSseUrl',
            'lastTransportType',
            'lastBearerToken',
            'lastHeaderName',
        ];
        for (const key of keysToRemove) {
            localStorage.removeItem(key);
        }
    }
    // PRIVATE CONVERSION METHODS
    convertToServerConfig(name, config) {
        const transportType = config.transportType || 'stdio';
        const serverConfig = {
            name,
            transportType: transportType,
            timeout: config.timeout || 30000,
            enableServerLogs: config.enableServerLogs || false,
        };
        if (transportType === 'stdio') {
            serverConfig.command = config.command || 'npx';
            serverConfig.args = config.args || [];
            serverConfig.env = config.env || {};
        }
        else {
            serverConfig.url = config.url;
            serverConfig.requestInit = config.requestInit;
            serverConfig.eventSourceInit = config.eventSourceInit;
            serverConfig.reconnectionOptions = config.reconnectionOptions;
            serverConfig.sessionId = config.sessionId;
        }
        if (config.capabilities) {
            serverConfig.capabilities = config.capabilities;
        }
        return serverConfig;
    }
    convertToRequestHistory(request, serverIdMap) {
        const clientId = serverIdMap.get(request.clientId);
        if (!clientId) {
            // Skip requests for servers that don't exist
            return null;
        }
        return {
            name: request.name,
            description: request.description,
            toolName: request.toolName,
            toolDefinition: request.tool,
            parameters: request.parameters,
            clientId,
            isFavorite: request.isFavorite || false,
            tags: request.tags || [],
        };
    }
    convertToUserPreferences(prefs) {
        return {
            theme: prefs.theme || 'system',
            uiLayout: prefs.uiLayout,
            paneHeights: prefs.paneHeights,
            autoOpenEnabled: prefs.autoOpenEnabled !== false,
            hasSeenStarModal: prefs.hasSeenStarModal || false,
        };
    }
    convertToProviderConfig(providerType, config) {
        return {
            providerType: providerType,
            apiKey: config.apiKey,
            baseUrl: config.baseUrl,
            model: config.model,
            configuration: config.configuration,
            isActive: config.isActive !== false,
        };
    }
}
// Export convenience function
export const createMigrator = (database) => new DatabaseMigrator(database);
// Export default migrator instance
export const migrator = new DatabaseMigrator(new MCPJamDatabase());
