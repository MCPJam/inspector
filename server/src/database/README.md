# MCPJam Inspector Database Foundation

This directory contains a basic libSQL database foundation for the MCPJam Inspector - a simple, local SQLite database setup for future features.

## Overview

The database layer provides:

- **Basic libSQL/SQLite foundation** for local database functionality
- **Simple app metadata storage** for key-value data
- **Type-safe operations** with basic TypeScript interfaces
- **Local-only storage** in `~/.mcpjam/data.db`

## Structure

```
database/
├── DatabaseManager.ts    # Core database management class
├── schema.sql           # Basic database schema
├── types.ts            # TypeScript interfaces and types
├── routes.ts           # Express API routes
├── utils.ts            # Utility functions
├── index.ts            # Module exports
└── README.md           # This file
```

## Quick Start

### Basic Usage

```typescript
import { DatabaseManager, getDatabaseConfig } from "./database/index.js";

// Initialize database
const config = getDatabaseConfig();
const db = new DatabaseManager(config);
await db.initialize();

// Store metadata
await db.setMetadata("app_version", "1.0.0");

// Get metadata
const version = await db.getMetadata("app_version");
console.log(version); // '1.0.0'

// Get all metadata
const allMetadata = await db.getAllMetadata();
```

### API Endpoints

The database provides basic REST API endpoints under `/api/db/`:

```bash
# App metadata operations
GET    /api/db/metadata           # Get all metadata
GET    /api/db/metadata/:key      # Get specific metadata value
POST   /api/db/metadata/:key      # Set metadata value
DELETE /api/db/metadata/:key      # Delete metadata key

# Health check
GET    /api/db/health             # Database health check
```

## Configuration

### Environment Variables

```bash
# For local database (default: ~/.mcpjam/data.db)
MCPJAM_DB_PATH=/custom/path/to/data.db
```

### Local Database

The database path is resolved using a **single source of truth**:

1. `MCPJAM_DB_PATH` environment variable (if set)
2. `~/.mcpjam/data.db` (default fallback)

This eliminates confusion between multiple path resolution methods.

## Database Schema

### Current Tables

- **app_metadata**: Basic key-value storage for application metadata
  - Includes automatic versioning and timestamps
  - Pre-populated with database version and creation time

## Type Safety

All database operations are fully typed with TypeScript:

```typescript
import { AppMetadata, DatabaseError, QueryError } from "./database/types.js";

// Type-safe operations
const metadata: AppMetadata[] = await db.getAllMetadata();
const value: string | null = await db.getMetadata("some_key");
```

## Error Handling

The database layer provides custom error types:

```typescript
import { DatabaseError, QueryError } from "./database/types.js";

try {
  await db.setMetadata("key", "value");
} catch (error) {
  if (error instanceof DatabaseError) {
    console.error("Database error:", error.message, error.code);
  }
}
```

## API Usage Examples

```bash
# Get all metadata
curl http://localhost:6277/api/db/metadata

# Get specific value
curl http://localhost:6277/api/db/metadata/db_version

# Set a value
curl -X POST http://localhost:6277/api/db/metadata/app_setting \
  -H "Content-Type: application/json" \
  -d '{"value": "some_value"}'

# Delete a key
curl -X DELETE http://localhost:6277/api/db/metadata/old_key

# Health check
curl http://localhost:6277/api/db/health
```

## Development

### Adding New Features

1. Update `schema.sql` with new table definitions
2. Add corresponding TypeScript interfaces in `types.ts`
3. Implement database operations in `DatabaseManager.ts`
4. Add API endpoints in `routes.ts`
5. Update documentation

### Running Tests

```bash
# Test database connection
npm run test

# Test specific database functionality
npm test -- database
```

## Performance

- **Lightweight**: Single table with basic operations
- **Local-only**: No network overhead
- **Indexed**: Primary key indexing for fast lookups
- **Minimal**: Small footprint for basic metadata storage

## Security

- **Local storage**: Data stored locally, no remote access
- **Parameterized queries**: Protection against SQL injection
- **Directory permissions**: Respects filesystem permissions

## Monitoring

- **Health check endpoint**: `/api/db/health`
- **Error logging**: Comprehensive error reporting
- **Connection testing**: Built-in connection validation

## Future Expansion

This foundation can be easily extended to support:

- Additional tables for specific features
- More complex data types and relationships
- Caching layers for performance
- Advanced querying capabilities

---

This database foundation provides a simple, reliable base for local data storage that can grow with the MCPJam Inspector's needs.
