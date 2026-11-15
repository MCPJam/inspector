#!/usr/bin/env bash
set -u
cd /workspace
for entry in 'negative|{"a":-7,"b":2}|-5' 'decimal|{"a":1.25,"b":2.5}|3.75' 'zero|{"a":0,"b":0}|0'; do
  IFS='|' read -r name args expected <<< "$entry"
  npx -y @mcpjam/cli@6.2.2 --no-telemetry tools call --url http://fixture:8765/mcp --access-token "$MCP_SERVER_TOKEN" --tool-name add --tool-args "$args" --format json > "validation/add-$name.json" 2> "validation/add-$name.stderr"
  python3 - "$name" "$expected" <<'PY'
import json,sys
name,expected=sys.argv[1:]
r=json.load(open('validation/add-'+name+'.json'))
assert r.get('isError') is False,r
assert r['structuredContent']['sum']==float(expected),r
print(name+': passed')
PY
done
