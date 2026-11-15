#!/bin/bash
# usage: MCP_SERVER_TOKEN=[REDACTED] ./validate.sh
C="npx -y @mcpjam/cli@latest"; U=http://fixture:8765/mcp
$C server doctor --url $U --access-token "$MCP_SERVER_TOKEN" --out doctor.json >/dev/null
$C tools call --url $U --access-token "$MCP_SERVER_TOKEN" --name add --params '{"a":2,"b":3}'
$C tools call --url $U --access-token "$MCP_SERVER_TOKEN" --name add --params '{"a":"x"}'
