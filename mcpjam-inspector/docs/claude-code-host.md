# The Claude Code host

Selecting **Claude Code** as a host runs the real `@ai-sdk` Claude Code harness
inside your project's Computer (an E2B Linux sandbox) instead of MCPJam's
emulated chat loop. You are observing the actual runtime — its native tools,
its own MCP client, its real execution behavior — not a simulation of it.

The host appears only when the `claude-code-host-enabled` feature flag is on
for your org.

## What happens when you run a turn

1. **Pre-flight.** The server checks the harness can actually run here
   (`server/utils/harness/harness-availability.ts`): broker credential
   delivery not kill-switched, computers data plane configured, an
   MCPJam-provided model the runtime supports, and host settings the runtime
   can honor. Any failure returns one clear error *before* the stream opens —
   a turn never silently falls back to the emulated engine.
2. **Computer wake.** The host's project Computer is reserved/woken (or
   provisioned on first use). Harness hosts **require** a Computer — there is
   no local fallback.
3. **Credential delivery.** Convex mints a short-lived model lease and
   installs it into the E2B egress transform **outside the VM** — neither the
   sandbox nor your browser ever holds a real model credential. The CLI runs
   with dummy creds pointed at MCPJam's model proxy, which verifies the lease
   and meters every generation. The broker is the **only** credential path;
   there is no raw-key fallback.
4. **MCP delivery.** Selected MCP servers are written into the session's
   `.mcp.json`, each pointed at MCPJam's per-server proxy tunnel — no upstream
   credentials enter the box.
5. **The turn runs.** Claude Code's own agent loop executes; native tools
   (Bash, Read, Write, …) run in-sandbox; file changes land on the Computer's
   disk; the transcript and trace persist like any other chat. On a host that
   requires tool approval, side-effecting built-ins pause the turn and resume
   with your decision (see the table below).

## What the host toggles control (and don't)

| Host setting | Harness behavior |
|---|---|
| Model | Honored — must be an MCPJam-provided Anthropic model (BYOK fails closed; the CLI maps it to its native alias). |
| System prompt | Honored (passed to the runtime). |
| Require tool approval | Honored for **native and host-executed** tools (WS3): the adapter runs the CLI in its `allow-edits` permission mode, so side-effecting built-ins pause the turn and resume with your decision; reads stay free. The runtime can't pause for **MCP-server** tools, so approval combined with selected MCP servers is rejected pre-flight (`supportsMcpToolApproval: false`). The Behavior tab doesn't offer the toggle for harness hosts (`client/src/lib/harness-capabilities.ts` marks it not enforced). |
| Selected MCP servers | Honored — delivered via `.mcp.json` through MCPJam's proxy. |
| Skills | Honored (runtime skills are materialized into the sandbox). |
| Temperature / other sampling knobs | **Not honored** — the CLI owns its sampling. Grayed out in the UI. |
| Progressive tool disclosure | **Not applied** — the real runtime owns tool discovery; the emulated-engine disclosure knobs don't exist here. |

**Enforcement honesty:** the harness's MCP traffic flows through MCPJam's
proxy, but host-page *tool-level* toggles (e.g. tool visibility) are not
re-enforced server-side for harness runs. Knobs the harness can't honor are
disabled in the UI rather than silently ignored.

## Requirements

- A project **Computer** (E2B data plane configured; deployed servers
  bootstrap via `INSPECTOR_SERVICE_TOKEN`).
- An **MCPJam-provided model** on the host.
- A signed-in **project member** (guests run only via host-funded swarms,
  capped).

No credential configuration is needed — broker delivery is on by default and
the backend broker and model proxy are always-on. The one related setting is
an emergency kill switch: `MCPJAM_HARNESS_BROKER_DELIVERY=false` on the
inspector makes harness runs unavailable with a pre-stream error. It is a
shutoff, never a bypass.

## Billing

- **Computer time:** harness runtime keeps the Computer awake, so it meters
  into the org's monthly computer-time allowance exactly like terminal use
  (10 credits/hour past the allowance once billing is in enforce mode).
- **Model tokens:** every generation is priced and settled by the model proxy
  into `llmUsageRecord` against your org — the same accounting as chat — and
  spend caps and empty-wallet rejections apply before the stream starts.

## Failure modes you may see

None of these fall back to the emulated engine — a turn that says it ran the
real runtime did. All fail closed; a failed start spends nothing.

| Condition | What you see |
|---|---|
| Broker delivery kill-switched (`MCPJAM_HARNESS_BROKER_DELIVERY=false`) | Pre-flight error naming the kill switch — harness runs are unavailable on that server. |
| Enterprise-managed authorization policy on the host | Pre-flight error — the harness MCP proxy can't carry the policy, so the combination is rejected rather than silently bypassed. |
| Require tool approval + selected MCP servers | Pre-flight error — the runtime can't pause for approval of MCP-server tools; turn approval off or remove the servers. |
| Computers data plane not configured | Pre-flight error naming the data plane requirement. |
| Model not MCPJam-provided / not runnable | Pre-flight error asking you to pick an eligible model. |
| Computer at daily start cap | Start-limit dialog with upgrade CTA. |
| Org out of compute allowance + credits (enforce mode) | Computer pauses with the "Paused for billing" notice. |
| Org spending limit reached | Clean rejection at broker start (429), before any model call. |
| Sandbox dies mid-run | Turn errors; next turn starts a fresh session ("the project computer was reset"). |
