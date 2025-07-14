/**
 * Database types and interfaces for MCPJam Inspector
 * Basic foundation types for local SQLite database
 */

// ============================================================================
// BASIC DATABASE TYPES
// ============================================================================

export interface AppMetadata {
  key: string;
  value: string;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// DATABASE CONFIGURATION
// ============================================================================

export interface DatabaseConfig {
  localPath: string; // Resolved path to local SQLite file
}

// ============================================================================
// ERROR TYPES
// ============================================================================

export class DatabaseError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "DatabaseError";
  }
}

export class QueryError extends Error {
  constructor(
    message: string,
    public readonly query?: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "QueryError";
  }
}
