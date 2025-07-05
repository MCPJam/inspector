/**
 * MCP Jam Inspector Shared Database
 * Main entry point for the shared database module
 */
// Export main database class and utilities
export { MCPJamDatabase, database, initializeDatabase, closeDatabase } from './database';
// Export migration utilities
export { DatabaseMigrator, migrator, createMigrator } from './migration';
// Export all types
export * from './types';
// Export schema path for programmatic access
export const SCHEMA_PATH = './schema.sql';
