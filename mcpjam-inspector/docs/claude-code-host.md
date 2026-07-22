# The Claude Code host

Selecting **Claude Code** as a host runs the real `@ai-sdk` Claude Code harness
inside your project's Computer (an E2B Linux sandbox) instead of MCPJam's
emulated chat loop. You are observing the actual runtime — its native tools,
its own MCP client, its real tool-approval behavior — not a simulation of it.

> **Status: pre-GA.** The host is behind the `claude-code-host-enabled` flag.
> Sections below marked **after COMP-23** describe behavior that only exists
> once the COMP-23 broker branches deploy; everything else describes `main`
> as it runs today. See `docs/comp-15-ga-readiness.md`.

## What happens when you run a turn

1. **Pre-flight.** The server checks the harness can actually run here
   (`server/utils/harness/harness-availability.ts`): computers data plane
   configured, an MCPJam-provided model the runtime supports, and approval
   settings the runtime can honor. Any failure returns one clear error
   *before* the stream opens. **After COMP-23** this check also reads the
   broker kill switch, so a broker-less server fails here too; today it does
   not (see *Requirements* and *Failure modes*).
2. **Computer wake.** The host's project Computer is reserved/woken (or
   provisioned on first use). Harness hosts **require** a Computer — there is
   no local fallback.
3. **Credential delivery.** With broker delivery **on**
   (`MCPJAM_HARNESS_BROKER_DELIVERY=true`), Convex mints a short-lived model
   lease and installs it into the E2B egress transform **outside the VM** —
   neither the sandbox nor your browser ever holds a real model credential,
   and the CLI runs with dummy creds pointed at MCPJam's model proxy.
   With the switch unset (today's default) a member turn instead takes the
   legacy **client-lease** path, which hands a real Gateway credential to the
   sandbox and is **not metered** — the reason GA is blocked on COMP-23. That
   path is itself gated on the backend (`MCPJAM_HARNESS_ALLOW_ENV_CREDENTIAL`),
   so with every flag unset the turn fails closed rather than leaking; the
   unmetered spend only happens where that backend flag is on.
   Host-funded swarm (guest) turns never take that path at all: they fail
   closed when the broker is off.
4. **MCP delivery.** Selected MCP servers are written into the session's
   `.mcp.json`, each pointed at MCPJam's per-server proxy tunnel — no upstream
   credentials enter the box.
5. **The turn runs.** Claude Code's own agent loop executes; native tools
   (Bash, Read, Write, …) run in-sandbox; file changes land on the Computer's
   disk; the transcript and trace persist like any other chat. WS3 tool
   approvals pause the turn and resume with your decision *when the host
   carries approval* — which the Behavior tab currently can't set (see the
   table below).

## What the host toggles control (and don't) today

| Host setting | Harness behavior |
|---|---|
| Model | Honored — must be an MCPJam-provided Anthropic model (BYOK fails closed; the CLI maps it to its native alias). |
| System prompt | Honored (passed to the runtime). |
| Require tool approval | **Disabled in the Behavior tab today** (`harness-capabilities.ts` marks it not enforced), so it can't be switched on from the host UI. The server side is ready: a host that does carry approval gets it honored for **native and host-executed** tools (WS3, `supportsNativeToolApproval`), and a host with approval + selected MCP servers is rejected pre-flight (`supportsMcpToolApproval: false`). |
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
- **Broker delivery enabled** — set `MCPJAM_HARNESS_BROKER_DELIVERY=true`
  explicitly on the inspector, plus the backend broker/proxy flags
  (`MCPJAM_HARNESS_MODEL_PROXY_ENABLED`, `MCPJAM_HARNESS_MODEL_BROKER_ENABLED`,
  `HARNESS_MODEL_LEASE_SECRET` on Convex). See
  `mcpjam-backend/docs/harness-broker-rollout.md`.
  **This is not optional in practice:** on `main` the flag defaults to *off*
  (`harnessBrokerDeliveryEnabled()` is `=== "true"`), and a member turn with
  it off silently uses the unmetered client-lease path. **After COMP-23** the
  switch inverts to a default-on kill switch (`!== "false"`) and the broker
  becomes the only credential path.
- An **MCPJam-provided model** on the host.
- A signed-in **project member** (guests run only via host-funded swarms,
  capped and broker-only).

## Billing

- **Computer time:** harness runtime keeps the Computer awake, so it meters
  into the org's monthly computer-time allowance exactly like terminal use
  (10 credits/hour past the allowance once billing is in enforce mode).
- **Model tokens — after COMP-23:** every generation is priced and settled by
  the model proxy into `llmUsageRecord` against your org, and spend caps and
  empty-wallet rejections apply before the stream starts.
  **Today, on `main`, do not rely on this.** Only credential *issuance* is
  audited and rate-limited; per-generation spend ingestion is still follow-up
  work, and a member turn on the legacy client-lease path spends MCPJam's
  gateway key with no `llmUsageRecord`, no credit consumption, and no spend
  cap. This is the GA blocker tracked in `docs/comp-15-ga-readiness.md`.

## Failure modes you may see

None of these fall back to the emulated engine — a turn that says it ran the
real runtime did. All fail closed except one: broker delivery off on a member
turn, which silently degrades to the unmetered client-lease path until
COMP-23 lands (first row below).

| Condition | What you see |
|---|---|
| Broker delivery disabled — member turn | **No error today** — the turn silently falls back to the unmetered client-lease path. **After COMP-23:** pre-flight error naming `MCPJAM_HARNESS_BROKER_DELIVERY`. |
| Broker delivery disabled — host-funded swarm (guest) turn | Fail-closed error naming `MCPJAM_HARNESS_BROKER_DELIVERY=true`, raised in-turn by `run-harness-turn`. |
| Computers data plane not configured | Pre-flight error naming the data plane requirement. |
| Model not MCPJam-provided / not runnable | Pre-flight error asking you to pick an eligible model. |
| Computer at daily start cap | Start-limit dialog with upgrade CTA. |
| Org out of compute allowance + credits (enforce mode) | Computer pauses with the "Paused for billing" notice. |
| Org spending limit reached (broker path only) | Clean rejection at broker start (429), before any model call. |
| Sandbox dies mid-run | Turn errors; next turn starts a fresh session ("the project computer was reset"). |
