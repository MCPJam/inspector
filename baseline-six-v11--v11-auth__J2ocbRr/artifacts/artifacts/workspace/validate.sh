#!/bin/bash
# usage: MCP_SERVER_TOKEN=[REDACTED] ./validate.sh
U=http://fixture:8765/mcp
npx -y @mcpjam/cli server doctor --url $U --access-token "$MCP_SERVER_TOKEN" --rpc --out doctor.json
npx -y @mcpjam/cli tools call --url $U --access-token "$MCP_SERVER_TOKEN" --tool-name add --tool-args '{"a":2,"b":3}'
