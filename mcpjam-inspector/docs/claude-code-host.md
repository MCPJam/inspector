# The Claude Code host

Selecting **Claude Code** as a host runs the real `@ai-sdk` Claude Code harness
inside your project's Computer (an E2B Linux sandbox) instead of MCPJam's
emulated chat loop. You are observing the actual runtime — its native tools,
its own MCP client, its real tool-approval behavior — not a simulation of it.

## What happens when you run a turn

1. **Pre-flight.** The server checks the harness can actually run here
   (`server/utils/harness/harness-availability.ts`): computers data plane
   configured, broker credential delivery enabled, an MCPJam-provided model
   selected, approval settings the runtime can honor. Any failure returns one
   clear error *before* the stream opens.
2. **Computer wake.** The host's project Computer is reserved/woken (or
   provisioned on first use). Harness hosts **require** a Computer — there is
   no local fallback.
3. **Credential broker.** Convex mints a short-lived model lease and installs
   it into the E2B egress transform **outside the VM** — neither the sandbox
   nor your browser ever holds a real model credential. The CLI runs with
   dummy creds pointed at MCPJam's metered model proxy. Model spend is metered
   per generation into your org's normal usage accounting (same as chat).
4. **MCP delivery.** Selected MCP servers are written into the session's
   `.mcp.json`, each pointed at MCPJam's per-server proxy tunnel — no upstream
   credentials enter the box.
5. **The turn runs.** Claude Code's own agent loop executes; native tools
   (Bash, Read, Write, …) run in-sandbox; WS3 tool approvals pause the turn
   and resume with your decision; file changes land on the Computer's disk;
   the transcript and trace persist like any other chat.

## What the host toggles control (and don't) today

| Host setting | Harness behavior |
|---|---|
| Model | Honored — must be an MCPJam-provided Anthropic model (BYOK fails closed; the CLI maps it to its native alias). |
| System prompt | Honored (passed to the runtime). |
| Require tool approval | Honored for **native and host-executed** tools (WS3). NOT available for MCP-server tools — a host with approval + selected servers is rejected pre-flight. |
| Selected MCP servers | Honored — delivered via `.mcp.json` through MCPJam's proxy. |
| Skills | Honored (runtime skills are materialized into the sandbox). |
| Temperature / other sampling knobs | **Not honored** — the CLI owns its sampling. Grayed out in the UI (`client/src/lib/harness-capabilities.ts`). |
| Progressive tool disclosure | **Not applied** — the real runtime owns tool discovery; the emulated-engine disclosure knobs don't exist here. |

**Enforcement honesty:** the harness's MCP traffic flows through MCPJam's
proxy, but host-page *tool-level* toggles are not re-enforced server-side for
harness runs yet (the enforcement proxy is follow-up work). Knobs the harness
can't honor are disabled in the UI rather than silently ignored.

## Requirements

- A project **Computer** (E2B data plane configured; deployed servers
  bootstrap via `INSPECTOR_SERVICE_TOKEN`).
- **Broker delivery enabled** (default): `MCPJAM_HARNESS_BROKER_DELIVERY`
  unset or `true` on the inspector, and the backend broker/proxy flags set
  (`MCPJAM_HARNESS_MODEL_PROXY_ENABLED`, `MCPJAM_HARNESS_MODEL_BROKER_ENABLED`,
  `HARNESS_MODEL_LEASE_SECRET` on Convex). See
  `mcpjam-backend/docs/harness-broker-rollout.md`.
- An **MCPJam-provided model** on the host.
- A signed-in **project member** (guests run only via host-funded swarms,
  capped and broker-only).

## Billing

- **Computer time:** harness runtime keeps the Computer awake, so it meters
  into the org's monthly computer-time allowance exactly like terminal use
  (10 credits/hour past the allowance once billing is in enforce mode).
- **Model tokens:** every generation is priced and settled by the model proxy
  into `llmUsageRecord` against your org — spend caps and empty-wallet
  rejections apply before the stream starts.

## Failure modes you may see (all fail closed, none fall back to emulated)

| Condition | What you see |
|---|---|
| Computers data plane not configured | Pre-flight error naming the data plane requirement. |
| Broker delivery disabled on the server | Pre-flight error naming `MCPJAM_HARNESS_BROKER_DELIVERY`. |
| Model not MCPJam-provided / not runnable | Pre-flight error asking you to pick an eligible model. |
| Computer at daily start cap | Start-limit dialog with upgrade CTA. |
| Org out of compute allowance + credits (enforce mode) | Computer pauses with the "Paused for billing" notice. |
| Org spending limit reached | Clean rejection at broker start (429), before any model call. |
| Sandbox dies mid-run | Turn errors; next turn starts a fresh session ("the project computer was reset"). |
