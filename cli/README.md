# @mcpjam/cli

Test, debug, and validate MCP servers. Health checks, OAuth conformance, tool-surface diffing, and structured triage from the terminal or CI.

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

Test, debug, and validate MCP servers. Health checks, OAuth conformance, tool-surface diffing, and structured triage from the terminal or CI.

Options:
  -v, --version      output the CLI version
  --timeout <ms>     Request timeout in milliseconds (default: 30000)
  --rpc              Include RPC logs in JSON output
  --quiet            Suppress non-result progress output
  --no-telemetry     Disable anonymous usage telemetry
  --format <format>  Output format
  -h, --help         display help for command

Commands:
  server             Inspect MCP server connectivity and capabilities
  tools              List and invoke MCP server tools
  resources          List and read MCP resources
  prompts            List and fetch MCP prompts
  apps               MCP Apps utilities, widget extraction, and conformance checks
  oauth              Run MCP OAuth login, proxy, and conformance flows
  protocol           MCP protocol inspection and conformance checks
  inspector          Start or attach to the local MCPJam Inspector
  telemetry          Inspect and configure anonymous CLI telemetry
```

## Quick start

```bash
# Probe: is the server reachable? What transport? Is OAuth configured?
mcpjam server probe --url https://your-server.com/mcp

# Health check: MCP handshake, tool/resource/prompt sweep, exit code 0 or fail
mcpjam server doctor --url https://your-server.com/mcp --access-token $TOKEN

# OAuth login
mcpjam oauth login --url https://your-server.com/mcp --protocol-version 2025-11-25

# MCP Apps conformance
mcpjam apps conformance --url https://your-server.com/mcp --access-token $TOKEN

# Render a UI-capable tool result in Inspector
mcpjam tools call --url https://your-server.com/mcp --access-token $TOKEN \
  --tool-name create_view --tool-args @params.json --ui --quiet --format json

# List tools with full schemas
mcpjam tools list --url https://your-server.com/mcp --access-token $TOKEN --format json
```

## Why

MCP servers don't have built-in health checks, OAuth conformance tests, or deploy-time regression detection. `mcpjam` adds those.

## What it does

### CI gate on every deploy

Run `server doctor` in your pipeline. It probes connectivity, runs the MCP handshake, and sweeps every tool, resource, and prompt. Exit code 0 or the build fails.

```bash
mcpjam server doctor --url $MCP_SERVER_URL --access-token $TOKEN --format json
```

### Catch breaking changes before they ship

`server export` snapshots your entire tool surface as diffable JSON. A renamed parameter or changed description shows up in the diff.

```bash
mcpjam server export --url $URL --access-token $TOKEN > before.json
# deploy...
mcpjam server export --url $URL --access-token $TOKEN > after.json
diff <(jq -S . before.json) <(jq -S . after.json)
```

### OAuth conformance across the full matrix

Cover the full registration × protocol version × auth mode matrix from a single config file. Outputs JUnit XML.

```bash
mcpjam oauth conformance-suite --config ./oauth-matrix.json --reporter junit-xml > report.xml
```

### Verify tokens work end-to-end

OAuth can succeed while `tools/list` returns 401 because the audience, scope, or session init is wrong. `--verify-call-tool` completes the full chain (OAuth, MCP connect, tool call) and reports which step fails.

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

`--debug-out` captures a JSON artifact with every request and response in the OAuth and MCP flow. Attach it to a ticket instead of writing reproduction steps.

```bash
mcpjam oauth login --url $URL --protocol-version 2025-11-25 \
  --registration dcr --debug-out oauth-debug.json
```

### Incident triage

Separate your failures from host-side failures. `--rpc` records what your server returned (transport type, status codes, raw JSON-RPC pairs) as a structured artifact for postmortems.

```bash
mcpjam server doctor --url $URL --access-token $TOKEN --rpc --out incident-triage.json
```

### Tool surface audit

Pipe the full schema inventory into your own linter, review it in a PR, or check whether descriptions are clear enough for tool selection.

```bash
mcpjam tools list --url $URL --access-token $TOKEN --format json \
  | jq '.tools[] | {name, description, inputSchema}'
```

### JSON input ergonomics

JSON-valued flags accept inline JSON, `@path`, or `-` for stdin:

```bash
mcpjam tools call --url $URL --access-token $TOKEN \
  --tool-name search_docs --tool-args @params.json --quiet --format json

echo '{"query":"setup guide"}' | mcpjam tools call --url $URL --access-token $TOKEN \
  --tool-name search_docs --tool-args - --quiet --format json
```

Use `--format json|human` for the raw command result. Use `--reporter json-summary|junit-xml` on conformance and diff commands when CI needs a report artifact. `server validate` uses `--debug-out` for validation artifacts.

## Telemetry

`mcpjam` collects anonymous command-level telemetry so we can understand CLI usage and reliability. Events include the command/subcommand name, success/failure, exit code, duration, CLI version, Node version, OS, CPU architecture, transport type (`http` or `stdio`), `platform: "cli"`, and coarse CI metadata (`is_ci` and a provider enum such as `github_actions`).

Telemetry is enabled by default. The first command invocation that is not opted out writes `telemetry.json` with `enabled: true` and a random install UUID.

Telemetry uses a random install UUID stored at the same platform cache location as update checks, in `telemetry.json`. It does not collect raw argv, URLs, hostnames, ports, tokens, headers, environment values, working directories, file paths, tool/resource/prompt names, error messages, stack traces, repository names, branch names, workflow names, or CI job ids.

Disable telemetry for one invocation with `--no-telemetry`, or persistently with:

```bash
mcpjam telemetry disable
```

Check or re-enable it with:

```bash
mcpjam telemetry status
mcpjam telemetry enable
```

Set `DO_NOT_TRACK=1` or `MCPJAM_TELEMETRY_DISABLED=1` to disable telemetry through the environment. Set `MCPJAM_TELEMETRY_DEBUG=1` to print the sanitized telemetry payload to stderr instead of sending it.

## GitHub Actions

```yaml
name: MCP Health Check

on:
  push:
    branches: [main]
  pull_request:

jobs:
  mcp-doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: OAuth login (headless)
        run: |
          set -euo pipefail
          npx -y @mcpjam/cli@latest oauth login \
            --url ${{ secrets.MCP_SERVER_URL }} \
            --protocol-version 2025-11-25 \
            --registration dcr \
            --auth-mode headless \
            --format json > /tmp/oauth-result.json
          TOKEN=$(jq -r '.credentials.accessToken // empty' /tmp/oauth-result.json)
          rm -f /tmp/oauth-result.json
          if [ -z "$TOKEN" ]; then
            echo "::error::OAuth login did not return an access token"
            exit 1
          fi
          echo "::add-mask::$TOKEN"
          echo "MCP_TOKEN=$TOKEN" >> "$GITHUB_ENV"

      - name: Run doctor
        run: npx -y @mcpjam/cli@latest server doctor --url ${{ secrets.MCP_SERVER_URL }} --access-token $MCP_TOKEN --format json
```

If you already have a refresh token, you can skip the login step and pass it directly:

```bash
mcpjam server doctor --url $URL --refresh-token $REFRESH_TOKEN --client-id $CLIENT_ID --client-secret $CLIENT_SECRET --format json
```

See the full [CI documentation](https://docs.mcpjam.com/cli/ci) for all authentication options.

## Documentation

Full docs at [docs.mcpjam.com/cli](https://docs.mcpjam.com/cli).
