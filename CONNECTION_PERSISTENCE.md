# Connection Persistence

The MCPJam Inspector now supports persistent storage of manually configured connections to a file (`mcp.json`) on disk. This allows connections to persist across application restarts and enables easy sharing and backup of configurations.

## Features

- ✅ **Automatic persistence** - Connections are automatically saved to `mcp.json` when modified
- ✅ **File-first loading** - On startup, loads from file first, then falls back to localStorage  
- ✅ **Manual save/export** - Buttons to manually save or export connections
- ✅ **Import functionality** - Import connections from JSON files with merge or replace options
- ✅ **Docker volume support** - Known file path for easy Docker volume mounting
- ✅ **Backup and sharing** - Export connections for backup or sharing between environments

## File Location

### Default Location
By default, connections are saved to:
```
mcp.json
```
in the application's working directory.

### Custom Location
You can customize the file location using the `MCP_CONNECTIONS_FILE` environment variable:
```bash
export MCP_CONNECTIONS_FILE="/path/to/your/connections.json"
```

## Usage

### Basic Usage

1. **Automatic Saving**: Connections are automatically saved to `mcp.json` whenever you:
   - Add a new connection
   - Edit an existing connection  
   - Remove a connection

2. **Manual Operations**: Use the Settings tab to:
   - **Save to File**: Manually save current connections
   - **Export**: Download connections as a JSON file
   - **Import (Replace)**: Replace all connections with imported ones
   - **Import (Merge)**: Add imported connections to existing ones

### Settings Tab

Navigate to the **Settings** tab in the MCPJam Inspector to access connection persistence features:

- **Save to File**: Saves current connections to `mcp.json`
- **Export**: Downloads connections as `mcp-connections-YYYY-MM-DD.json`
- **Import (Replace)**: Overwrites existing connections 
- **Import (Merge)**: Adds imported connections alongside existing ones

## Docker Usage

### Volume Mounting

To persist connections across Docker container restarts, mount the file or directory as a volume:

#### Option 1: Mount the file directly
```bash
docker run -d \
  -p 6274:6274 \
  -v /host/path/to/mcp.json:/app/mcp.json \
  mcpjam/mcp-inspector:main
```

#### Option 2: Mount the data directory
```bash
docker run -d \
  -p 6274:6274 \
  -v /host/path/to/data:/app/data \
  -e MCP_CONNECTIONS_FILE=/app/data/mcp.json \
  mcpjam/mcp-inspector:main
```

#### Option 3: Named volume (recommended)
```bash
# Create a named volume
docker volume create mcp-data

# Run with named volume
docker run -d \
  -p 6274:6274 \
  -v mcp-data:/app/data \
  -e MCP_CONNECTIONS_FILE=/app/data/mcp.json \
  mcpjam/mcp-inspector:main
```

### Docker Compose Example

```yaml
version: '3.8'

services:
  mcp-inspector:
    image: mcpjam/mcp-inspector:main
    ports:
      - "6274:6274"
      - "6277:6277"
    volumes:
      - mcp-data:/app/data
    environment:
      - MCP_CONNECTIONS_FILE=/app/data/mcp.json
    restart: unless-stopped

volumes:
  mcp-data:
```

## File Format

The `mcp.json` file stores connections in the following format:

```json
{
  "my-stdio-server": {
    "transportType": "stdio",
    "command": "npx",
    "args": ["@modelcontextprotocol/server-everything"],
    "env": {},
    "timeout": 30000,
    "enableServerLogs": true
  },
  "my-sse-server": {
    "transportType": "sse", 
    "url": "https://api.example.com/mcp",
    "timeout": 30000,
    "enableServerLogs": true
  },
  "my-http-server": {
    "transportType": "streamable-http",
    "url": "https://api.example.com/mcp",
    "requestInit": {
      "headers": {
        "Authorization": "Bearer token"
      }
    },
    "timeout": 30000,
    "enableServerLogs": true
  }
}
```

## API Endpoints

The backend provides REST endpoints for connection management:

### Load Connections
```http
GET /connections
```
**Response:**
```json
{
  "success": true,
  "connections": { ... },
  "source": "file",
  "filePath": "/app/mcp.json"
}
```

### Save Connections  
```http
POST /connections
Content-Type: application/json

{
  "connections": { ... }
}
```

### Export Connections
```http
GET /connections/export
```
Downloads connections as `mcp-connections-YYYY-MM-DD.json`

### Import Connections
```http
POST /connections/import
Content-Type: application/json

{
  "connections": { ... },
  "merge": false
}
```

## Migration from localStorage

When you first use the new version:

1. **Existing localStorage connections** will be automatically migrated to `mcp.json`
2. **Going forward**, the app will load from `mcp.json` first, then fall back to localStorage
3. **Manual migration**: Use Export → Import to explicitly move configurations

## Backup and Sharing

### Creating Backups
1. Click **Export** in the Settings tab
2. Save the downloaded JSON file in a safe location
3. The file can be imported later or shared with others

### Sharing Configurations
1. Export your connections to a JSON file
2. Share the file with team members
3. They can import using **Import (Merge)** to add to their existing connections

### Version Control
You can even version control your `mcp.json` file:

```bash
# Add to .gitignore if it contains sensitive data
echo "mcp.json" >> .gitignore

# Or commit it for team sharing (remove secrets first)
git add mcp.json
git commit -m "Add MCP server configurations"
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_CONNECTIONS_FILE` | `./mcp.json` | Path to the connections file |

## Troubleshooting

### File Permission Issues
```bash
# Ensure the app has write permissions
chmod 644 /path/to/mcp.json
chown app:app /path/to/mcp.json  # if running as non-root user
```

### Docker Volume Issues
```bash
# Check if volume exists
docker volume inspect mcp-data

# Check file contents
docker run --rm -v mcp-data:/data alpine cat /data/mcp.json
```

### File Not Loading
1. Check file exists: `ls -la mcp.json`
2. Check file format: `cat mcp.json | jq .` (requires jq)
3. Check app logs for error messages
4. Verify file permissions

## Security Considerations

- **Sensitive Data**: The connections file may contain API keys and tokens
- **File Permissions**: Ensure appropriate file permissions (600 or 644)
- **Volume Security**: Use appropriate Docker volume security practices
- **Backup Security**: Store backups securely, especially if they contain credentials
- **Environment Variables**: Consider using environment variables for sensitive configuration

## Development

### Running Locally
```bash
# Set custom file location for development
export MCP_CONNECTIONS_FILE="./dev-connections.json"
npm run dev
```

### Testing
```bash
# Test with different file locations
MCP_CONNECTIONS_FILE="/tmp/test-mcp.json" npm run dev
```

This feature makes it easy to maintain consistent MCP server configurations across different environments and share setups with team members.