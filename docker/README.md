# MCPJam Inspector - Docker Self-Hosted Setup

Run MCPJam Inspector with a self-hosted [Convex](https://github.com/get-convex/convex-backend) backend.

## Quick Start

```bash
# Start all services
docker compose up -d

# Generate Convex admin key (first run only)
docker compose exec convex-backend ./generate_admin_key.sh

# View logs
docker compose logs -f
```

## Access Points

| Service | URL | Description |
|---------|-----|-------------|
| MCPJam Inspector | http://localhost:6274 | Main UI |
| Convex Dashboard | http://localhost:6791 | Database admin |
| Convex API | http://localhost:3210 | Backend API |
| Convex HTTP Actions | http://localhost:3211 | HTTP endpoints |

## Configuration

Create a `.env` file to customize ports:

```env
# Inspector
INSPECTOR_PORT=6274

# Convex
CONVEX_PORT=3210
CONVEX_SITE_PORT=3211
CONVEX_DASHBOARD_PORT=6791

# Disable Convex telemetry beacon
DISABLE_BEACON=true
```

## Current Limitations

> **Note**: This setup provides partial self-hosting. Full self-hosting requires code changes.

### What Works
- ✅ Self-hosted Convex database
- ✅ MCP server connections (stdio, SSE, HTTP)
- ✅ Tools, Resources, Prompts inspection
- ✅ JSON-RPC tracing

### What Requires External Services
- ❌ **User Authentication** - Requires [WorkOS](https://workos.com/) (commercial SaaS)
- ❌ **Evals persistence** - Requires authenticated user
- ❌ **Workspaces** - Requires authenticated user
- ❌ **LLM Playground free models** - MCPJam-provided models require auth

### Workarounds
- Use the inspector without signing in for basic MCP testing
- Bring your own API keys for LLM playground
- Store server configs locally (no cloud sync)

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Docker Network                      │
│                                                      │
│  ┌──────────────┐     ┌────────────────────────┐    │
│  │   Convex     │◄────│   MCPJam Inspector     │    │
│  │   Backend    │     │                        │    │
│  │  :3210/3211  │     │       :6274            │    │
│  └──────────────┘     └────────────────────────┘    │
│         │                        │                   │
│         ▼                        ▼                   │
│  ┌──────────────┐     ┌────────────────────────┐    │
│  │   Convex     │     │   Your MCP Servers     │    │
│  │  Dashboard   │     │  (stdio/SSE/HTTP)      │    │
│  │    :6791     │     │                        │    │
│  └──────────────┘     └────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

## Connecting to MCP Servers

### Host Machine Servers (stdio)

For MCP servers running on your host machine, the inspector container needs access. Options:

1. **Use network mode host** (Linux only):
   ```yaml
   mcp-inspector:
     network_mode: host
   ```

2. **Mount server binaries**:
   ```yaml
   mcp-inspector:
     volumes:
       - /path/to/server:/app/server
   ```

### Network Servers (SSE/HTTP)

Use `host.docker.internal` to reach the host:
```
http://host.docker.internal:8080/sse
```

Or connect to other containers on the same network by service name.

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for development setup.

For full self-hosting support (bypassing WorkOS), see:
- Issue: [#XXX](https://github.com/MCPJam/inspector/issues/XXX) (TODO: create issue)
