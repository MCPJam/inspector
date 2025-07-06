/**
 * MCP Jam Inspector Shared Database
 * Main entry point for the shared database module
 */
export { MCPJamDatabase, DatabaseConfig, database, initializeDatabase, closeDatabase } from './database';
export { DatabaseMigrator, LocalStorageData, MigrationResult, migrator, createMigrator } from './migration';
export * from './types';
export declare const SCHEMA_PATH = "./schema.sql";
