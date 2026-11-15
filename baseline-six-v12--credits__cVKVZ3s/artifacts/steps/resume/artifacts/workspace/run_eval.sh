#!/bin/bash
# Repeatable: rerun suite_fixture, poll to verdict. Output in /workspace/run_*.json
H="Authorization: Bearer $MCPJAM_API_KEY"; B=$MCPJAM_API_URL; P=project_fixture
curl -s -m 20 -X POST -H "$H" -H "Content-Type: application/json" -H "x-mcpjam-launcher: workspace-script" \
  -d '{"suiteId":"suite_fixture"}' $B/projects/$P/eval-runs | tee run_create.json; echo
RID=$(python3 -I -c "import json;print(json.load(open('run_create.json')).get('runId',''))")
[ -z "$RID" ] && exit 2
for i in $(seq 1 10); do curl -s -H "$H" $B/projects/$P/eval-runs/$RID > run_status.json; cat run_status.json; echo; grep -qE '"status": ?"(running|queued|pending)"' run_status.json || break; sleep 5; done
