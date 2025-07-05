/**
 * Migration utility to move data from localStorage to the shared database
 * This should be run when users upgrade from localStorage-based storage to the shared database
 */
import { MCPJamDatabase } from "./database";
export interface LocalStorageData {
    serverConfigs?: Record<string, any>;
    selectedServer?: string;
    requestHistory?: any[];
    userPreferences?: {
        theme?: string;
        uiLayout?: any;
        paneHeights?: any;
        autoOpenEnabled?: boolean;
        hasSeenStarModal?: boolean;
    };
    providerConfigs?: Record<string, any>;
    appSettings?: Record<string, any>;
    sessionData?: {
        lastCommand?: string;
        lastArgs?: string;
        lastSseUrl?: string;
        lastTransportType?: string;
        lastBearerToken?: string;
        lastHeaderName?: string;
    };
}
export interface MigrationResult {
    success: boolean;
    migratedCounts: {
        serverConfigs: number;
        requestHistory: number;
        providerConfigs: number;
        userPreferences: number;
        appSettings: number;
        sessions: number;
    };
    errors: string[];
}
export declare class DatabaseMigrator {
    private database;
    constructor(database: MCPJamDatabase);
    /**
     * Extract data from localStorage (browser environment only)
     */
    extractLocalStorageData(): LocalStorageData | null;
    /**
     * Migrate data from localStorage format to the shared database
     */
    migrateData(data: LocalStorageData): Promise<MigrationResult>;
    /**
     * Perform a full migration from localStorage to database
     */
    performFullMigration(): Promise<MigrationResult>;
    /**
     * Check if migration is needed (localStorage has data but database is empty)
     */
    isMigrationNeeded(): Promise<boolean>;
    /**
     * Clear localStorage after successful migration
     */
    clearLocalStorage(): void;
    private convertToServerConfig;
    private convertToRequestHistory;
    private convertToUserPreferences;
    private convertToProviderConfig;
}
export declare const createMigrator: (database: MCPJamDatabase) => DatabaseMigrator;
export declare const migrator: DatabaseMigrator;
