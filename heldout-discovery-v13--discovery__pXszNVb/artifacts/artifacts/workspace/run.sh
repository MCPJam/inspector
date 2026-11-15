U=http://fixture:8765/mcp
mcpjam server doctor --url $U --out doctor.json >/dev/null 2>&1
for p in '{"a":2,"b":3}' '{"a":-1.5,"b":0.25}' '{"a":1e308,"b":1e308}' '{"a":"x","b":1}' '{"a":1}'; do echo "== $p"; mcpjam tools call --url $U --tool-name add --tool-args "$p" 2>&1 | head -c 600; echo; done
