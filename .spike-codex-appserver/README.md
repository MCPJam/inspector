# `.spike-codex-appserver` — the codex app-server preflight rig

Reproducible probes for the direct `codex app-server` transport, kept in the repo
so the findings in `RESULTS.md` can be re-checked rather than believed. Nothing
here ships: it is a scratch instrument, deliberately not shared with the adapter
in `mcpjam-inspector/server/utils/harness/codex-appserver/`, so a probe change
can never move production behaviour.

## Layout

| Path | What it is |
| --- | --- |
| `schema/0.149.1/` | The pinned protocol contract: the four union files in full, plus `MANIFEST.json` (sha256 of all 291 generated files) |
| `schema/regen.sh` | Regenerate a snapshot for a new codex version |
| `schema/diff.mjs` | Diff two snapshots; exits non-zero if a method was REMOVED |
| `probe/app-server-client.mjs` | Dependency-free JSONL JSON-RPC client for `codex app-server` |
| `probe/fake-responses-server.mjs` | Scripted OpenAI Responses API stand-in, so gates are deterministic and free |
| `probe/tiny-mcp-server.mjs` | One-tool stdio MCP server for the MCP gate |
| `probe/run-gates.mjs` | The P1-P4 gates |
| `artifacts/` | Raw wire logs from the last run (gitignored) |

## Running

```sh
# All gates, against a codex binary you already have:
node probe/run-gates.mjs --codex /path/to/codex

# One gate:
node probe/run-gates.mjs --codex /path/to/codex --gate P2

# Without a local binary (fetches the pinned version via npx):
node probe/run-gates.mjs
```

Each gate writes `artifacts/<gate>.ndjson` (every JSON-RPC frame in both
directions) and `artifacts/<gate>.http.ndjson` (every request codex made to the
model, including its full tool declarations). Those logs are the evidence behind
`RESULTS.md`, and the recorder for the adapter's translator fixtures.

## On a codex version bump

```sh
./schema/regen.sh 0.152.0 --diff
```

`diff.mjs` reports added/removed/changed payloads and, for the four union files,
which methods appeared or disappeared. An addition is informational; a **removal**
fails the command, because the adapter dispatches on those names.
