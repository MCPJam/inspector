# MCP Jam Inspector Shared Database

A unified database layer for MCP Jam Inspector that enables data sharing between CLI, SDK, and UI components using libSQL.

## Overview

This shared database system replaces the localStorage-based storage with a robust, cross-platform solution that can be accessed by:

- **Web UI**: Browser-based interface
- **CLI**: Command-line interface
- **SDK**: Future programmatic access
- **Server Components**: Backend services

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Shared Database Layer                    │
├─────────────────────────────────────────────────────────────┤
│  libSQL Database (~/.mcpjam/data.db)                      │
│  ├─ server_configs     (MCP server configurations)         │
│  ├─ request_history    (Saved tool requests)               │
│  ├─ user_preferences   (Theme, UI settings)                │
│  ├─ provider_configs   (AI provider settings)              │
│  ├─ app_settings       (Application configuration)         │
│  └─ sessions           (CLI/UI session state)              │
└─────────────────────────────────────────────────────────────┘
```

## Features

- **Cross-platform compatibility**: Works in Node.js and browser environments
- **Type-safe**: Full TypeScript support with comprehensive type definitions
- **Migration support**: Automatic migration from localStorage to database
- **Local and remote sync**: Supports both local SQLite and remote Turso databases
- **ACID transactions**: Ensures data integrity
- **Optimized queries**: Indexed columns for fast lookups

## Installation

```bash
# From the shared/database directory
npm install

# Build the module
npm run build
```

## Usage

### Basic Database Operations

```typescript
import { database, initializeDatabase } from '@mcpjam/shared-database';

// Initialize the database
await initializeDatabase();

// Create a server configuration
const serverConfig = await database.createServerConfig({
  name: 'my-server',
  transportType: 'stdio',
  command: 'npx',
  args: ['@modelcontextprotocol/server-everything'],
  env: { NODE_ENV: 'development' }
});

// Get all server configurations
const configs = await database.getAllServerConfigs();

// Update user preferences
await database.updateUserPreferences({
  theme: 'dark',
  autoOpenEnabled: true
});
```

### Migration from localStorage

```typescript
import { migrator } from '@mcpjam/shared-database';

// Check if migration is needed
const needsMigration = await migrator.isMigrationNeeded();

if (needsMigration) {
  // Perform migration
  const result = await migrator.performFullMigration();
  
  if (result.success) {
    console.log('Migration successful!');
    console.log('Migrated:', result.migratedCounts);
    
    // Clear localStorage after successful migration
    migrator.clearLocalStorage();
  } else {
    console.error('Migration failed:', result.errors);
  }
}
```

### Database Configuration

```typescript
import { MCPJamDatabase } from '@mcpjam/shared-database';

// Local database (default)
const localDb = new MCPJamDatabase();

// Remote database (Turso)
const remoteDb = new MCPJamDatabase({
  url: 'libsql://your-database-url.turso.io',
  authToken: 'your-auth-token'
});

// Custom local path
const customDb = new MCPJamDatabase({
  localPath: '/custom/path/to/database.db'
});
```

## API Reference

### Database Operations

#### Server Configurations

```typescript
// Create
await database.createServerConfig(input: CreateServerConfigInput): Promise<ServerConfig>

// Read
await database.getServerConfig(id: string): Promise<ServerConfig>
await database.getAllServerConfigs(filter?: ServerConfigFilter): Promise<ServerConfig[]>

// Update
await database.updateServerConfig(id: string, input: UpdateServerConfigInput): Promise<ServerConfig>

// Delete
await database.deleteServerConfig(id: string): Promise<void>
```

#### Request History

```typescript
// Create
await database.createRequestHistory(input: CreateRequestHistoryInput): Promise<RequestHistory>

// Read
await database.getRequestHistory(id: string): Promise<RequestHistory>
await database.getAllRequestHistory(filter?: RequestHistoryFilter, pagination?: PaginationOptions): Promise<PaginatedResult<RequestHistory>>

// Update
await database.updateRequestHistory(id: string, input: UpdateRequestHistoryInput): Promise<RequestHistory>

// Delete
await database.deleteRequestHistory(id: string): Promise<void>
```

#### User Preferences

```typescript
// Read
await database.getUserPreferences(): Promise<UserPreferences>

// Update
await database.updateUserPreferences(input: UpdateUserPreferencesInput): Promise<UserPreferences>
```

#### Provider Configurations

```typescript
// Create
await database.createProviderConfig(input: CreateProviderConfigInput): Promise<ProviderConfig>

// Read
await database.getProviderConfig(id: string): Promise<ProviderConfig>
await database.getAllProviderConfigs(filter?: ProviderConfigFilter): Promise<ProviderConfig[]>

// Update
await database.updateProviderConfig(id: string, input: UpdateProviderConfigInput): Promise<ProviderConfig>

// Delete
await database.deleteProviderConfig(id: string): Promise<void>
```

#### App Settings

```typescript
// Read
await database.getAppSetting(key: string): Promise<AppSetting>
await database.getAllAppSettings(): Promise<AppSetting[]>

// Update
await database.setAppSetting(key: string, value: string, valueType: string, description?: string): Promise<AppSetting>

// Delete
await database.deleteAppSetting(key: string): Promise<void>
```

#### Sessions

```typescript
// Create
await database.createSession(input: CreateSessionInput): Promise<Session>

// Read
await database.getSession(id: string): Promise<Session>
await database.getCurrentSession(sessionType: string): Promise<Session | null>

// Update
await database.updateSession(id: string, input: UpdateSessionInput): Promise<Session>
await database.endSession(id: string): Promise<Session>
```

## Database Schema

### Tables

- **`server_configs`**: MCP server definitions and transport configurations
- **`request_history`**: Saved tool requests with parameters and metadata
- **`user_preferences`**: UI theme, layout, and user settings
- **`provider_configs`**: AI provider configurations (OpenAI, Anthropic, etc.)
- **`app_settings`**: Application-wide configuration settings
- **`sessions`**: CLI/UI session state and history

### Indexes

Optimized indexes are created for:
- `request_history.client_id`
- `request_history.tool_name`
- `request_history.is_favorite`
- `provider_configs.provider_type`
- `sessions.session_type`

## Migration from localStorage

The migration system automatically detects and converts existing localStorage data:

### Supported localStorage Keys

- `mcpServerConfigs_v1` → `server_configs`
- `selectedServerName_v1` → `sessions.selected_server_id`
- `mcpjam_saved_requests` → `request_history`
- `theme` → `user_preferences.theme`
- `hasSeenStarModal` → `user_preferences.has_seen_star_modal`
- `{provider}_config` → `provider_configs`
- `inspector_config` → `app_settings`
- Session keys → `sessions`

### Migration Process

1. **Detection**: Check if localStorage contains data and database is empty
2. **Extraction**: Parse all relevant localStorage keys
3. **Transformation**: Convert data to new schema format
4. **Insertion**: Populate database with migrated data
5. **Cleanup**: Optionally clear localStorage after successful migration

## Cloud Sync with Turso

Enable cloud synchronization by configuring a Turso database:

```typescript
const database = new MCPJamDatabase({
  url: 'libsql://your-db-name.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN
});
```

### Benefits of Cloud Sync

- **Cross-device synchronization**: Access your data from any device
- **Backup and recovery**: Automatic cloud backup
- **Collaboration**: Share configurations and requests with team members
- **Scalability**: Handle large datasets with cloud infrastructure

## Development

### Building

```bash
npm run build
```

### Development Mode

```bash
npm run dev
```

### Testing

```bash
npm test
```

## Integration Examples

### CLI Integration

```typescript
// cli/src/database.ts
import { database, initializeDatabase } from '@mcpjam/shared-database';

export async function initCliDatabase() {
  await initializeDatabase();
  
  // Create or update CLI session
  const session = await database.createSession({
    sessionType: 'cli',
    lastCommand: process.argv[2]
  });
  
  return session;
}
```

### UI Integration

```typescript
// client/src/hooks/useSharedDatabase.ts
import { database, migrator } from '@mcpjam/shared-database';

export function useSharedDatabase() {
  useEffect(() => {
    const initDb = async () => {
      // Check for migration
      if (await migrator.isMigrationNeeded()) {
        const result = await migrator.performFullMigration();
        if (result.success) {
          migrator.clearLocalStorage();
        }
      }
      
      await database.initialize();
    };
    
    initDb();
  }, []);
  
  return database;
}
```

## Performance Considerations

### Connection Management

- Database connections are pooled and reused
- Call `database.close()` when shutting down applications
- Initialize once per application lifecycle

### Query Optimization

- Use filters and pagination for large datasets
- Leverage indexes for frequently queried columns
- Batch operations when possible

### Memory Usage

- JSON fields are parsed on-demand
- Use pagination for large result sets
- Consider database cleanup for old sessions

## Security

### Local Database

- Database file is stored in user's home directory (`~/.mcpjam/`)
- File permissions restrict access to user only
- No network exposure by default

### Remote Database

- Uses TLS encryption for all communication
- Requires authentication tokens
- Supports row-level security (RLS) policies

## Troubleshooting

### Common Issues

1. **Database initialization fails**
   - Check directory permissions for `~/.mcpjam/`
   - Verify libSQL client version compatibility

2. **Migration fails**
   - Check localStorage data format
   - Verify database schema is up-to-date
   - Review migration error messages

3. **Connection issues**
   - Verify network connectivity for remote databases
   - Check authentication tokens
   - Ensure database URL is correct

### Debug Mode

Enable debug logging:

```typescript
process.env.DEBUG = 'mcpjam:database';
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Submit a pull request

## License

MIT License - see LICENSE file for details. 