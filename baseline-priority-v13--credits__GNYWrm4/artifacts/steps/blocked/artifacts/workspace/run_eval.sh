#!/bin/bash
# Repeatable eval: runs existing suite against saved server. Needs MCPJAM_API_URL/KEY.
npx -y @mcpjam/cli cloud eval run --suite suite_fixture --server server_fixture
