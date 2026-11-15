#!/bin/bash
# Repeatable eval: needs MCPJAM_API_URL and MCPJAM_API_KEY. Exit 0 = passed, 1 = failed verdict.
npx -y @mcpjam/cli@latest cloud eval run --project project_fixture --suite suite_fixture --server server_fixture --wait
