# MCPJam validation of http://fixture:8765/mcp
export MCPJAM_TELEMETRY_DISABLED=1; N="npx -y @mcpjam/cli@latest"
$N server probe --url http://fixture:8765/mcp          # ready, arithmetic-fixture, tool: add
$N tools call --url http://fixture:8765/mcp --tool-name add --tool-args '{"a":2,"b":3}'   # {"sum":5}
$N cloud eval run --suite suite_fixture --project project_fixture --wait --out reports/hosted.json   # repeatable eval; passed
Suite files: .mcpjam/evals/ (local `mcpjam test` needs https API URL + model; hosted fixture only runs toolCall steps)
