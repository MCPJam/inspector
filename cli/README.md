# @mcpjam/cli

Stateless MCP server probing, debugging, OAuth, and conformance from your terminal.

## Install

```bash
# Global (gives you the mcpjam command)
npm i -g @mcpjam/cli

# Or run without installing
npx -y @mcpjam/cli@latest --help
```

> **Note:** All examples below use `mcpjam` directly. If you installed via `npx`, replace `mcpjam` with `npx -y @mcpjam/cli@latest`.

## Command groups

| Group | Purpose | Key commands |
|-------|---------|-------------|
| `server` | Triage connectivity and capabilities | `probe`, `doctor`, `info`, `validate`, `ping`, `capabilities`, `export` |
| `oauth` | Test OAuth flows and conformance | `conformance`, `conformance-suite`, `login`, `metadata`, `proxy` |
| `tools` | Exercise the tool surface | `list`, `call` |
| `resources` | Read resources and templates | `list`, `read`, `templates` |
| `prompts` | Fetch prompts | `list`, `get` |
| `protocol` | MCP protocol conformance checks | `conformance` |

## Global flags

| Flag | Default | Description |
|------|---------|-------------|
| `--timeout <ms>` | `30000` | Request timeout in milliseconds |
| `--rpc` | off | Include raw JSON-RPC request/response logs in output |
| `--format <format>` | `human` on TTY, `json` when piped | Output format (`json`, `human`, or `junit-xml` for conformance commands) |
| `-v, --version` | | Print the CLI version |

## Output formats

The CLI auto-detects whether stdout is a terminal:

- **Interactive terminal** — defaults to `--format human`, a compact readable summary.
- **Piped or redirected** (CI, `| jq`, agent invocation) — defaults to `--format json`, the full structured result.
- **Explicit `--format`** always wins over the auto-detected default.

**For agents**: raw JSON is the source of truth. Human format is a lossy presentation layer. If you're parsing output programmatically, always pass `--format json`.

## Connecting to servers

The CLI supports two transport modes, selected by which flags you pass:

### HTTP (Streamable HTTP / SSE)

```bash
mcpjam server doctor --url https://your-server.com/mcp
```

Add auth when needed:

```bash
# Static bearer token
mcpjam server doctor --url https://your-server.com/mcp --access-token $TOKEN

# OAuth tokens from a prior login
mcpjam server doctor --url https://your-server.com/mcp --oauth-access-token $TOKEN

# Custom headers
mcpjam server doctor --url https://your-server.com/mcp --header "X-API-Key: $KEY"
```

### Stdio (local subprocess)

```bash
mcpjam server doctor --command node --command-args server.js --env API_KEY=$KEY
```

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success / all checks passed |
| `1` | Command ran but reported a failure (e.g., server unhealthy, conformance failed) |
| `2` | Invalid arguments or configuration |

## Quick triage workflow

The fastest path from "I have a server URL" to "I know what's wrong":

```bash
# 1. One-shot health check (probe + connect + sweep)
mcpjam server doctor --url https://your-server.com/mcp

# 2. If oauth_required: get a token
mcpjam oauth login --url https://your-server.com/mcp \
  --protocol-version 2025-11-25 --registration dcr

# 3. Re-run doctor with the token
mcpjam server doctor --url https://your-server.com/mcp --oauth-access-token $TOKEN

# 4. Exercise tools directly
mcpjam tools list --url https://your-server.com/mcp --access-token $TOKEN
mcpjam tools call --url https://your-server.com/mcp --access-token $TOKEN \
  --tool-name my_tool --tool-args '{"key": "value"}'
```

## Full documentation

For detailed guides on each command group, see the [full CLI docs](https://docs.mcpjam.com/cli).
