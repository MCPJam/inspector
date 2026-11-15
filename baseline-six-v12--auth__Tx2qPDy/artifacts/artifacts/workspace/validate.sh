#!/bin/bash
# Reproduce: MCP_SERVER_TOKEN must be set
U=http://fixture:8765/mcp
npx -y @mcpjam/cli server doctor --url $U --access-token "$MCP_SERVER_TOKEN" --out doctor.json >/dev/null 2>&1
npx -y @mcpjam/cli tools call --url $U --access-token "$MCP_SERVER_TOKEN" --tool-name add --tool-args '{"a":2,"b":3.5}'
npx -y @mcpjam/cli tools call --url $U --access-token "$MCP_SERVER_TOKEN" --tool-name add --tool-args '{"a":"x","b":1}'
