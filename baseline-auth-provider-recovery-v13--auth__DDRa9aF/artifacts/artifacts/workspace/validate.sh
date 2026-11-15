#!/bin/bash
# usage: MCP_SERVER_TOKEN=[REDACTED] ./validate.sh
M="npx -y @mcpjam/cli@latest"; A="--url http://fixture:8765/mcp --access-token $MCP_SERVER_TOKEN"
$M server doctor $A --out doctor.json >/dev/null 2>&1
$M tools list $A
$M tools call $A --tool-name add --tool-args '{"a":2,"b":3}'
$M tools call $A --tool-name add --tool-args '{"a":"x"}'
