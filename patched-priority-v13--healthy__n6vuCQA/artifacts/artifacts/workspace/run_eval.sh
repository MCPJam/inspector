#!/usr/bin/env bash
# Repeatable eval: author suite from suite.json, run it, poll, print verdict. Exit 1 if not passed.
set -u
H="Authorization: Bearer $MCPJAM_API_KEY"; P=$MCPJAM_API_URL/projects/project_fixture
D=$(dirname "$0")
S=$(curl -s -X POST -H "$H" -H "Content-Type: application/json" -d @"$D/suite.json" $P/eval-suites | python3 -I -c "import json,sys;print(json.load(sys.stdin)['suiteId'])")
R=$(curl -s -X POST -H "$H" -H "Content-Type: application/json" -d "{\"suiteId\":\"$S\"}" $P/eval-runs | python3 -I -c "import json,sys;print(json.load(sys.stdin)['runId'])") || exit 2
for i in $(seq 20); do o=$(curl -s -H "$H" $P/eval-runs/$R); echo "$o" | grep -q '"status": "running"' || break; sleep 2; done
echo "$o"; curl -s -H "$H" $P/eval-runs/$R/iterations
echo "$o" | grep -q '"result": "passed"'
