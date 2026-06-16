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
E2B_API_KEY=…  ANTHROPIC_API_KEY=…  npm run spike
# also honored: ANTHROPIC_AUTH_TOKEN, AI_GATEWAY_API_KEY/_BASE_URL, ANTHROPIC_BASE_URL
# SPIKE_MODEL (default claude-sonnet-4-5), SPIKE_E2B_TEMPLATE
```

This environment has only `ANTHROPIC_BASE_URL` set — no E2B or Anthropic key — so
it has not been run here.

## Open runtime requirements / risks

- **E2B template needs Node** (for the harness bridge + the stdio MCP server).
  Use a template with Node 20+ (ideally the `claude` CLI / agent SDK pre-baked so
  cold starts aren't an `npm install`). Set `SPIKE_E2B_TEMPLATE`.
- **Model id** — `SPIKE_MODEL` default is a guess; set the real current CC model.
- **Fallback** if the harness proves Vercel-coupled at runtime: drive
  `@anthropic-ai/claude-agent-sdk` directly inside the E2B sandbox (just needs the
  provider's command/file/`getHost` primitives) — no dependence on the harness
  sandbox abstraction.
