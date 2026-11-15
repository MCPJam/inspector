#!/bin/bash
# Repeatable: probe server, then run hosted eval suite. Needs MCPJAM_API_URL/MCPJAM_API_KEY.
export MCPJAM_PROJECT=project_fixture
M="npx -y @mcpjam/cli@latest"
$M server probe --url http://fixture:8765/mcp >/dev/null && echo probe ok
$M cloud eval run --suite suite_fixture --wait --reporter json-summary --out /workspace/run1.json
