#!/bin/bash
# usage: MCP_SERVER_TOKEN=[REDACTED] ./validate.sh
U="--url http://fixture:8765/mcp --access-token $MCP_SERVER_TOKEN"
npx -y @mcpjam/cli@latest server doctor $U --rpc --out doctor.json
npx -y @mcpjam/cli@latest tools call $U --tool-name add --tool-args '{"a":2,"b":3}'
npx -y @mcpjam/cli@latest tools call $U --tool-name add --tool-args '{"a":"x"}'
