# MCPJam CLI - MVP Plan

## Overview

Build a CLI tool (`mcpjam`) that allows agents (and developers) to interact with MCP servers while reusing the mcpjam-inspector backend for real-time visibility into agent operations.

### Goals
1. **Agent-first**: Structured JSON output with typed error codes for iteration
2. **Real-time visibility**: UI shows agent operations via existing SSE infrastructure
3. **Backend reuse**: Leverage existing Hono server, MCPClientManager, and SSE streams
4. **Simple auth**: Session-token based (inherit from inspector)

### Key Decisions
- **Backend**: Assume inspector is already running (CLI just connects)
- **Elicitation**: Not supported in MVP (tools requiring user input will fail with clear error)
- **Multi-server**: Support multiple simultaneous MCP server connections

---

## Architecture

```
┌─────────────────┐     HTTP/REST      ┌──────────────────────┐
│     mcpjam      │ ◄───────────────► │  mcpjam-inspector    │
│     (new)       │                    │  backend (existing)  │
└─────────────────┘                    └──────────────────────┘
       │                                        │
       │ JSON output                            │ SSE streams
       ▼                                        ▼
  ┌─────────┐                           ┌─────────────────┐
  │  Agent  │                           │  UI (browser)   │
  │(Claude) │                           │  shows activity │
  └─────────┘                           └─────────────────┘
```

**Key insight**: The inspector backend already has:
- MCPClientManager for MCP connections
- SSE streams for RPC logs, progress, elicitation
- Session token auth
- All the MCP primitives (tools, resources, prompts)

The CLI just needs to be a thin HTTP client that talks to these endpoints.

---

## MVP Scope

### Phase 1: Core CLI (MVP)

#### 1.1 CLI Structure
```bash
mcpjam <command> [options]

# Server Management
mcpjam connect <url|config>      # Connect to MCP server
mcpjam disconnect <server-id>    # Disconnect from server
mcpjam servers                   # List all connected servers

# Tools (require --server when multiple connected)
mcpjam tools list [--server <id>]
mcpjam tools call <name> [args] [--server <id>]

# Resources
mcpjam resources list [--server <id>]
mcpjam resources read <uri> [--server <id>]

# Prompts
mcpjam prompts list [--server <id>]
mcpjam prompts get <name> [--server <id>]

# Global options
--backend <url>     # Inspector backend URL (default: http://localhost:6274)
--token <token>     # Session token (or MCPJAM_TOKEN env var)
--json              # Force JSON output (default for piped output)
--server <id>       # Target specific server
--agent-id <id>     # Identify agent in logs (shows in UI)
```

#### 1.2 Package: `@mcpjam/cli`
Published to npm as `@mcpjam/cli`. Users install with:
```bash
npm install -g @mcpjam/cli
# or
npx @mcpjam/cli <command>
```

#### 1.3 Files to Create
```
packages/cli/
├── package.json           # name: "@mcpjam/cli", bin: { "mcpjam": "./bin/mcpjam.js" }
├── tsconfig.json
├── src/
│   ├── index.ts           # Entry point
│   ├── cli.ts             # Command parsing (commander.js)
│   ├── client.ts          # HTTP client for backend
│   ├── output.ts          # Formatting (human/JSON)
│   ├── errors.ts          # Typed error codes
│   ├── config.ts          # Config loading
│   └── commands/
│       ├── connect.ts
│       ├── servers.ts
│       ├── tools.ts
│       ├── resources.ts
│       └── prompts.ts
└── bin/
    └── mcpjam.js          # Executable (binary name: "mcpjam")
```

#### 1.4 Error Handling (Agent-Friendly)
```typescript
// Exit codes
enum ExitCode {
  Success = 0,
  ClientError = 1,     // Invalid args, command not found
  ServerError = 2,     // Tool failed, resource not found
  NetworkError = 3,    // Connection failed, timeout
  AuthError = 4,       // Invalid token, forbidden
}

// JSON error format
interface CLIError {
  code: string;           // "TOOL_EXECUTION_FAILED"
  message: string;        // Human-readable
  details?: unknown;      // Server error details
  suggestion?: string;    // "Try: mcpjam tools list"
}
```

### Phase 2: Agent Identification & UI Visibility

#### 2.1 Agent Context Header
Add a header to identify which agent/session is making requests:

```bash
mcpjam tools call search --agent-id "claude-session-123"
```

This gets passed to backend as `X-Agent-Id` header.

#### 2.2 Backend Changes
```typescript
// New middleware in server/middleware/agent-context.ts
export function agentContext(): MiddlewareHandler {
  return async (c, next) => {
    c.set('agentId', c.req.header('X-Agent-Id') || 'anonymous');
    await next();
  };
}

// Add to RPC log events
rpcLogBus.emit({
  ...message,
  agentId: c.get('agentId'),  // NEW
  timestamp: new Date().toISOString(),
});
```

#### 2.3 UI Enhancement (Future)
- Show agent ID in RPC log stream
- Filter by agent
- Color-code different agents

---

## Security Considerations

### Session Token Model (MVP)
- CLI uses same session token as inspector
- Token passed via `--token` or `MCPJAM_TOKEN` env var
- Inspector displays token on startup for easy copy

### Token Discovery Flow
```bash
# 1. User starts inspector (gets token on startup)
# 2. CLI discovers token automatically:
#    a. Check MCPJAM_TOKEN env var
#    b. Try GET /api/session-token from localhost
#    c. Fail with helpful error if neither works

# Example output when inspector starts:
# ┌─────────────────────────────────────────┐
# │  MCPJam Inspector running on :6274      │
# │  CLI Token: mcpjam_abc123...            │
# │  export MCPJAM_TOKEN=mcpjam_abc123...   │
# └─────────────────────────────────────────┘
```

---

## Implementation Steps

### Step 1: Create CLI Package Structure
- [ ] Create `packages/cli/` directory
- [ ] Setup package.json with dependencies (commander, chalk)
- [ ] Setup tsconfig.json extending root config
- [ ] Create bin executable

### Step 2: Implement HTTP Client
- [ ] Create client.ts with fetch wrapper
- [ ] Handle session token auth
- [ ] Implement retry with backoff
- [ ] Typed error handling

### Step 3: Implement Core Commands
- [ ] `connect` - POST /api/mcp/connect
- [ ] `disconnect` - DELETE /api/mcp/servers/:id
- [ ] `servers` - GET /api/mcp/servers
- [ ] `tools list` - POST /api/mcp/tools/list
- [ ] `tools call` - POST /api/mcp/tools/execute
- [ ] `resources list` - POST /api/mcp/resources/list
- [ ] `resources read` - POST /api/mcp/resources/read
- [ ] `prompts list` - POST /api/mcp/prompts/list
- [ ] `prompts get` - POST /api/mcp/prompts/get

### Step 4: Multi-Server Support
- [ ] Add `--server` flag to all commands
- [ ] Auto-select when only one server connected
- [ ] Clear error when multiple servers and no --server specified

### Step 5: Agent Context
- [ ] Add `--agent-id` flag to CLI
- [ ] Create agent-context middleware in backend
- [ ] Update RPC log events to include agent ID

### Step 6: Token Discovery
- [ ] Update inspector to display token on startup
- [ ] Implement auto-discovery in CLI
- [ ] Add MCPJAM_TOKEN env var support

### Step 7: Testing & Polish
- [ ] Add integration tests
- [ ] Create example agent usage docs
- [ ] Test with Claude Code

---

## Verification Plan

1. **Basic flow**:
   - Start inspector: `npm run dev`
   - Run `mcpjam connect --url <mcp-server>`
   - Run `mcpjam servers` → see connected server
   - Run `mcpjam tools list --server <id>`
   - Run `mcpjam tools call <name> <args> --server <id>`
   - Open inspector UI → verify RPC log shows operations

2. **Multi-server flow**:
   - Connect to two MCP servers
   - Run `mcpjam servers` → see both
   - Run `mcpjam tools list` → error "multiple servers, specify --server"
   - Run `mcpjam tools list --server <id>` → success

3. **Error handling**:
   - Run command with invalid args → exit code 1, parseable JSON error
   - Call non-existent tool → exit code 2, includes tool name in error
   - Call with no backend running → exit code 3, "cannot connect to backend"
   - Call with invalid token → exit code 4, "authentication failed"

4. **Agent usage**:
   - Configure Claude Code to use CLI
   - Run: "list tools on my MCP server"
   - Intentionally cause error → verify agent can parse and retry
   - Verify agent ID shows in inspector UI

---

## Critical Files to Modify

**New files (packages/cli/):**
- `src/index.ts` - Entry point
- `src/cli.ts` - Command definitions (commander.js)
- `src/client.ts` - HTTP client for backend API
- `src/output.ts` - Human/JSON output formatting
- `src/errors.ts` - Error types and exit codes
- `src/commands/*.ts` - Command implementations

**Backend modifications:**
- `server/middleware/agent-context.ts` - New middleware for agent ID
- `server/app.ts` - Register agent context middleware
- `server/services/rpc-log-bus.ts` - Add agent ID to events
- `bin/start.js` - Display session token on startup
