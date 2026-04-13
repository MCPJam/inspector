# @mcpjam/cli

Test, debug, and validate MCP servers — health checks, OAuth conformance, tool-surface diffing, and structured triage from the terminal or CI.

## Install

```bash
npm i -g @mcpjam/cli
```

Or run without installing:

```bash
npx -y @mcpjam/cli@latest --help
```

## Commands

```
$ mcpjam --help

Usage: mcpjam [options] [command]

Test, debug, and validate MCP servers — health checks, OAuth conformance,
tool-surface diffing, and structured triage from the terminal or CI

Options:
  -v, --version      output the CLI version
  --timeout <ms>     Request timeout in milliseconds (default: 30000)
  --rpc              Include RPC logs in JSON output
  --format <format>  Output format
  -h, --help         display help for command

Commands:
  server             Inspect MCP server connectivity and capabilities
  tools              List and invoke MCP server tools
  resources          List and read MCP resources
  prompts            List and fetch MCP prompts
  apps               Fetch MCP App and ChatGPT App widget content
  oauth              Run MCP OAuth login, proxy, and conformance flows
  protocol           MCP protocol inspection and conformance checks
```

## Quick start

```bash
# Probe: is the server reachable? What transport? Is OAuth configured?
mcpjam server probe --url https://your-server.com/mcp

# Health check: MCP handshake, tool/resource/prompt sweep, exit code 0 or fail
mcpjam server doctor --url https://your-server.com/mcp --access-token $TOKEN

# OAuth login
mcpjam oauth login --url https://your-server.com/mcp --protocol-version 2025-11-25

# List tools with full schemas
mcpjam tools list --url https://your-server.com/mcp --access-token $TOKEN --format json
```

## Why

MCP servers ship without the testing infrastructure REST APIs take for granted. No health checks, no OAuth conformance tests, no deploy-time regression detection. `mcpjam` fills that gap.

## What it does

### CI gate on every deploy

Run `server doctor` in your pipeline. It probes connectivity, runs the MCP handshake, and sweeps every tool, resource, and prompt. Exit code 0 or the build fails.

```bash
mcpjam server doctor --url $MCP_SERVER_URL --access-token $TOKEN --format json
```

### Catch breaking changes before they ship

`server export` snapshots your entire tool surface — names, schemas, descriptions, capabilities — as diffable JSON. A renamed parameter or changed description shows up in the diff.

```bash
mcpjam server export --url $URL --access-token $TOKEN > before.json
# deploy...
mcpjam server export --url $URL --access-token $TOKEN > after.json
diff <(jq -S . before.json) <(jq -S . after.json)
```

### OAuth conformance across the full matrix

3 registration strategies (CIMD, DCR, preregistered) × 3 protocol versions × 3 auth modes = 27 flow combinations. The conformance suite covers the matrix from a single config file and outputs JUnit XML.

```bash
mcpjam oauth conformance-suite --config ./oauth-matrix.json --format junit-xml > report.xml
```

### Verify tokens work end-to-end

OAuth can succeed while `tools/list` returns 401 because the audience, scope, or session init is wrong. `--verify-call-tool` completes the full chain — OAuth, MCP connect, tool call — and reports which step fails.

```bash
mcpjam oauth conformance --url $URL --protocol-version 2025-11-25 \
  --registration dcr --verify-call-tool your_critical_tool
```

### Protocol version compatibility

MCP has shipped three protocol versions (2025-03-26, 2025-06-18, 2025-11-25). Clients upgrade on their own schedule. Declare the version matrix once and test on every push.

```json
{
  "flows": [
    { "label": "2025-03-26/dcr", "protocolVersion": "2025-03-26", "registrationStrategy": "dcr" },
    { "label": "2025-06-18/dcr", "protocolVersion": "2025-06-18", "registrationStrategy": "dcr" },
    { "label": "2025-11-25/cimd", "protocolVersion": "2025-11-25", "registrationStrategy": "cimd" }
  ]
}
```

### Structured debug artifacts

`--debug-out` captures a JSON artifact with every request and response in the OAuth and MCP flow. Attach it to a ticket — no reproduction steps required.

```bash
mcpjam oauth login --url $URL --protocol-version 2025-11-25 \
  --registration dcr --debug-out oauth-debug.json
```

### Incident triage

Separate your failures from host-side failures. `--rpc` records what your server returned — transport type, status codes, raw JSON-RPC pairs — as a structured artifact for postmortems.

```bash
mcpjam server doctor --url $URL --access-token $TOKEN --rpc --out incident-triage.json
```

### Tool surface audit

Pipe the full schema inventory into your own linter, review it in a PR, or check whether descriptions are clear enough for tool selection.

```bash
mcpjam tools list --url $URL --access-token $TOKEN --format json \
  | jq '.tools[] | {name, description, inputSchema}'
```

## Documentation

Full docs at [docs.mcpjam.com/cli](https://docs.mcpjam.com/cli).
