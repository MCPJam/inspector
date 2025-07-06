# Shared Database Setup

This document explains the shared database architecture that allows both the CLI and UI to access the same database.

## Architecture Overview

**Problem Solved**: Browser environments cannot access `file://` URLs due to security restrictions, but we want to share the same database between CLI and UI.

**Solution**: Client-Server Architecture (inspired by Mastra)
- **CLI**: Uses LibSQL directly with local file database (`~/.mcpjam/data.db`)
- **Server**: Provides HTTP API endpoints for database operations  
- **UI**: Uses HTTP client to access database through server API

This eliminates the browser LibSQL file:// URL issue while maintaining a truly shared database.

## How It Works

### Current Setup (Default - No Configuration Required)

**No setup needed!** This works out of the box:

1. **CLI**: Uses LibSQL directly with local file database (`~/.mcpjam/data.db`)
2. **Server**: Provides HTTP API endpoints at `/api/database/*`
3. **UI**: Uses HTTP client to communicate with server API

**Data Flow**:
```
CLI ←→ LibSQL File DB ←→ Server API ←→ HTTP ←→ Browser UI
```

Both CLI and UI share the exact same database with zero configuration.

### Advanced Configuration (Optional)

#### Option 1: Custom Server Port
If your server runs on a different port, update `client/.env.local`:
```
VITE_DATABASE_BASE_URL=http://localhost:YOUR_PORT
```

#### Option 2: Remote Database (Production)
For production deployments, you can configure the CLI and server to use a remote database:

**CLI/Server** (`.env` in root):
```
DATABASE_URL=libsql://your-database.turso.io
DATABASE_TOKEN=your-auth-token
```

The UI will automatically use the same database through the server API.

## Testing the Setup

1. **Start the UI**: `npm run dev`
2. **Check browser console** for database connection logs
3. **Use CLI**: Database operations should work on shared data

## Migration

The UI includes automatic migration from localStorage to the database on first load.

## File Structure

- `client/src/lib/database/browser-database-libsql.ts` - Browser database implementation
- `shared/database/database.ts` - Shared CLI/server database implementation
- `client/.env.local` - UI environment variables
- `.env` - CLI environment variables