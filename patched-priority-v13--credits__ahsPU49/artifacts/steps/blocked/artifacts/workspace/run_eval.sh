#!/bin/bash
# Repeatable eval: hosted suite against the Arithmetic server
export MCPJAM_PROJECT=project_fixture
npx -y @mcpjam/cli cloud eval run --suite suite_fixture --server server_fixture --iterations 1 --wait --wait-timeout 90000 --reporter json-summary --out /workspace/run1.json
