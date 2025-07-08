/**
 * DatabaseManager - Basic libSQL database manager for MCPJam Inspector
 * Simple local SQLite database foundation
 */

import { createClient, Client as LibSQLClient } from '@libsql/client';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ensureDirectoryExists, ensureMCPJamDirectory, getResolvedDatabasePath } from './utils.js';
import {
  DatabaseConfig,
  AppMetadata,
  DatabaseError,
  QueryError
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class DatabaseManager {
  private client: LibSQLClient;
  private initialized = false;
  private config: DatabaseConfig;

  constructor(config?: DatabaseConfig) {
    this.config = config || { localPath: getResolvedDatabasePath() };
    this.client = this.createClient();
  }

  private createClient(): LibSQLClient {
    // Use the configured database path
    const dbPath = this.config.localPath;
    return createClient({
      url: `file:${dbPath}`
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      console.log('🔄 Initializing database...');
      
      // Ensure .mcpjam directory exists and database directory
      await ensureMCPJamDirectory();
      const dbPath = getResolvedDatabasePath();
      await ensureDirectoryExists(dbPath);
      
      // Read and execute schema
      const schemaPath = join(__dirname, 'schema.sql');
      const schema = readFileSync(schemaPath, 'utf-8');
      
      await this.client.executeMultiple(schema);
      
      this.initialized = true;
      console.log('✅ Database initialized successfully');
    } catch (error) {
      throw new DatabaseError('Failed to initialize database', 'INIT_ERROR', error as Error);
    }
  }

  // ============================================================================
  // APP METADATA OPERATIONS
  // ============================================================================

  async getMetadata(key: string): Promise<string | null> {
    try {
      const result = await this.client.execute({
        sql: 'SELECT value FROM app_metadata WHERE key = ?',
        args: [key]
      });

      if (result.rows.length === 0) return null;
      return result.rows[0].value as string;
    } catch (error) {
      throw new QueryError('Failed to get metadata', undefined, error as Error);
    }
  }

  async setMetadata(key: string, value: string): Promise<void> {
    try {
      await this.client.execute({
        sql: 'INSERT OR REPLACE INTO app_metadata (key, value) VALUES (?, ?)',
        args: [key, value]
      });
    } catch (error) {
      throw new QueryError('Failed to set metadata', undefined, error as Error);
    }
  }

  async getAllMetadata(): Promise<AppMetadata[]> {
    try {
      const result = await this.client.execute({
        sql: 'SELECT * FROM app_metadata ORDER BY key',
        args: []
      });

      return result.rows.map(row => ({
        key: row.key as string,
        value: row.value as string,
        createdAt: new Date(row.created_at as string),
        updatedAt: new Date(row.updated_at as string)
      }));
    } catch (error) {
      throw new QueryError('Failed to get all metadata', undefined, error as Error);
    }
  }

  async deleteMetadata(key: string): Promise<void> {
    try {
      await this.client.execute({
        sql: 'DELETE FROM app_metadata WHERE key = ?',
        args: [key]
      });
    } catch (error) {
      throw new QueryError('Failed to delete metadata', undefined, error as Error);
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      this.client.close();
    }
  }
}