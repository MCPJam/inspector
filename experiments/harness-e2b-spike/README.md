# Phase 0 spike — Claude Code harness on E2B

Goal: prove the AI SDK v7 **Claude Code harness** runs on **our E2B setup** (not
Vercel's sandbox), and that an attached MCP server's tool calls are observable
with enough fidelity to grade. This is the go/no-go gate before building the
runtime (E2B provider → `.mcp.json` → `runHarnessTurn` → UI).

## Files

- `e2b-sandbox-provider.ts` — an E2B-backed `HarnessV1SandboxProvider`. The crux
  of "reuse our E2B": it implements the same contract the reference
  `@ai-sdk/sandbox-vercel` satisfies. **This is essentially Phase 2's starting
  point.** Pass `connectToSandboxId` to attach to MCPJam's per-(project,user)
  computer (reserve → `getComputerSandboxInfo` → sandboxId) instead of creating
  a fresh sandbox.
- `spike.ts` — runner: `createClaudeCode` + `HarnessAgent` + the E2B provider +
  a self-contained stdio MCP server written into the sandbox via
  `onSandboxSession`, then the two tests.

## What it already proves (no creds needed)

`npm install && npx tsc --noEmit` passes against the real
`@ai-sdk/harness@1.0.0-canary.13`, `@ai-sdk/harness-claude-code@1.0.0-canary.9`,
and `e2b@^2`. That validates the biggest unknowns at compile time:

- **The harness sandbox contract is generic, not Vercel-coupled** — an E2B
  provider satisfies `HarnessV1SandboxProvider` / `HarnessV1NetworkSandboxSession`.
- **E2B maps cleanly onto it:**
  | Contract | E2B |
  |---|---|
  | `getPortUrl({ port })` (bridge WebSocket) | `sandbox.getHost(port)` |
  | `readTextFile` / `writeTextFile` / binary / stream | `sandbox.files.read` / `.write` |
  | `run` / `spawn` | `sandbox.commands.run` (+ `background`) |
  | `id` / `stop` / `destroy` | `sandbox.sandboxId` / `.kill()` |
- The adapter wiring compiles: `createClaudeCode({ auth: { anthropic | gateway }, model, thinking })`, `new HarnessAgent({ harness, sandbox, instructions, permissionMode, onSandboxSession })`, `agent.createSession()`, `agent.stream({ session, prompt })`.

## What still needs a real run (creds required)

1. **Port exposure** — confirm the CC bridge's WebSocket actually works over
   E2B's `getHost` URL (`createSession()` resolving = bridge connected). TEST 1.
2. **MCP tool-call fidelity** — confirm Claude Code calls the attached MCP tool
   and the call (name + args) + result reach `fullStream` (sentinel check). TEST 2.

## Run it

```bash
npm install
E2B_API_KEY=…  ANTHROPIC_API_KEY=…  \
  SPIKE_E2B_TEMPLATE=ciq83q75k6orlaznpxo7  \
  npm run spike
# also honored: ANTHROPIC_AUTH_TOKEN, AI_GATEWAY_API_KEY/_BASE_URL, ANTHROPIC_BASE_URL
# SPIKE_MODEL  (default claude-sonnet-4-6; current Claude ids: claude-sonnet-4-6 / claude-opus-4-8)
# SPIKE_E2B_TEMPLATE  (MCPJam's computer template ciq83q75k6orlaznpxo7 ships Node 20)
# SPIKE_E2B_SECURE=false  (provision a non-secure box to isolate harness vs secure-URL issues)
```

This environment has only `ANTHROPIC_BASE_URL` set — no E2B or Anthropic key — so
it has not been run here.

## Confirmed by backend investigation

- **Reuse flow is exactly as guessed:** control plane `getOrReserveComputer`
  (Convex, idempotent per project+owner, wakes a hibernated box) → data plane
  `POST /computers/sandbox-info` (inspector server, gated by the
  `x-computers-data-plane-secret` / `COMPUTERS_DATA_PLANE_SECRET` header) returns
  `providerComputerId` = the E2B sandboxID = `connectToSandboxId`.
- **Where this belongs (Phase 2):** the provider + harness driver are *data-plane*
  code → live in the **inspector server**, authenticate with
  `COMPUTERS_DATA_PLANE_SECRET`, and call `/computers/sandbox-info` for the
  sandboxId. Convex stays control-plane only (no E2B SDK). `ownsSandbox=false` for
  reused boxes already matches the control plane owning teardown.
- **Template** `ciq83q75k6orlaznpxo7` ships Node 20 + a writable `/opt/npm-global`
  prefix; it does **not** pre-bake the `claude` CLI / `@anthropic-ai/claude-agent-sdk`
  (add to `templates/computer/e2b.Dockerfile` for cold-start, or `npm i -g` at session start).

## Gotchas to verify at runtime

1. **`secure: true` boxes.** Prod provisions every computer secure. The provider
   relies on the SDK resolving the per-sandbox envd token from the org `apiKey` on
   connect — TEST 1 (the getHost WebSocket) is exactly where a missing token would
   surface. If it fails, retry with `SPIKE_E2B_SECURE=false` to confirm it's the
   secure-URL path, then thread the envd token (and have `/computers/sandbox-info`
   return it for the reuse path).
2. **Hibernation racing the run.** Boxes auto-pause (~1h E2B timeout; idle cron
   ~30m). Reuse must wake via `getOrReserveComputer` first (Sandbox.connect won't
   resume), and keep `lastActiveAt` warm during a long run.
3. **Egress denylist (SSRF guard).** RFC1918 outbound is blocked. getHost bridge +
   remote MCP (public URLs) are fine; **local MCP servers must come in over the
   tunnel relay**, never a private address.

- **Fallback** if the harness proves Vercel-coupled or secure-URL handling is
  awkward: drive `@anthropic-ai/claude-agent-sdk` directly inside the E2B sandbox
  (only needs the provider's command/file/`getHost` primitives).
