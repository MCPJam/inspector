# mcp-check-fixture

The MCP server MCPJam's GitHub PR checks are validated against. This directory is
the **seed** for the standalone public repository `mcpjam/mcp-check-fixture` —
the only repo the walking-skeleton check pipeline is wired to
(`server/services/github-checks/recipes.ts`).

It lives here so it is reviewed alongside the pipeline that depends on it, and so
the ops step is "copy and push" rather than "write from scratch".

## Publishing it

```bash
cp -R test-servers/mcp-check-fixture /tmp/mcp-check-fixture
cd /tmp/mcp-check-fixture
git init && git add -A && git commit -m "mcp-check-fixture: minimal MCP server"
gh repo create mcpjam/mcp-check-fixture --public --source=. --push
```

`package-lock.json` is committed here on purpose, and must stay committed in the
published repo: the run recipe uses `npm ci`, which fails outright without one.
A repo missing its lockfile reports `build_failed` — correctly, but confusingly.
`@types/node` is likewise a real devDependency, not an assumption about the
build environment: `tsconfig.json` declares `"types": ["node"]`, and this package
is standalone with no workspace to hoist it from.

## The two things that must not be "cleaned up"

**It listens on the port the recipe declares (3001 / `$PORT`).** The bind
address is not load-bearing — E2B's bridge proxies from inside the sandbox and
reaches loopback-bound servers too (e2e-verified: a `127.0.0.1` bind passed the
check). Listening on any *other port* is what reports `server_unhealthy`.

**It answers `initialize` on `/mcp` immediately.** That handshake _is_ the health
probe — the worker polls it until it succeeds. Anything that delays it (a
warm-up, a lazily mounted route) reads as an unhealthy server.

## Run recipe

The recipe hardcoded in the Inspector for this repo:

| field     | value                     |
| --------- | ------------------------- |
| `build`   | `npm ci && npm run build` |
| `start`   | `npm start`               |
| `port`    | `3001`                    |
| `mcpPath` | `/mcp`                    |

Changing any of those means changing `recipes.ts` in the same breath.

## Tools

Three, all deterministic and side-effect-free — the eval suite's job is to prove
the pipeline works, not to be an interesting test:

- `echo({ text })` → the same text
- `add({ a, b })` → the sum
- `server_info()` → `{"name":"mcp-check-fixture","version":"1.0.0"}`

## Locally

```bash
npm install && npm run build && npm start
curl -s localhost:3001/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

## Exercising the check's failure modes

Each of these is a one-line change, and each should produce a specific check
conclusion — useful for verifying the pipeline end to end:

| Change                                | Expected outcome   | Check conclusion |
| ------------------------------------- | ------------------ | ---------------- |
| break a tool's return value           | `evals_failed`     | failure          |
| introduce a type error                | `build_failed`     | failure          |
| `throw` at the top of `server.ts`     | `server_unhealthy` | failure          |
| listen on a port other than 3001      | `server_unhealthy` | failure          |
