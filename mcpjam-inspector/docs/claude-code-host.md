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
| Require tool approval | **Switchable from the Behavior tab** (`client/src/lib/harness-capabilities.ts` marks it enforced for `claude-code`). Approval is honored on all three surfaces — **native, host-executed and MCP-server** tools. The adapter runs the CLI in its `allow-reads` permission mode, which is what makes the MCP case work: every call passes the bridge's `canUseTool` before the CLI may run it, and an external `mcp__<server>__<tool>` name falls into that table's `edit` default, which `allow-reads` gates. Reads stay free. (This row previously said MCP tools could not pause and that approval plus selected servers was rejected pre-flight; `claudeCodeAdapter.supportsMcpToolApproval` has been `true` since that was measured against the vendored bridge.) |
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

## Codex transports

Codex runs over one of two transports, selected by
`MCPJAM_CODEX_APPSERVER_TRANSPORT` (off by default). It is one host either way —
same harness id, same model rules, same host-executed MCP delivery — but NOT
one resumable session lane (see the fingerprint note below), and the difference
is what the runtime can be asked to do.

| | `codex exec` (default) | `codex app-server` |
|---|---|---|
| Adapter | `@ai-sdk/harness-codex` | `server/utils/harness/codex-appserver/` (ours) |
| Tool approval | Impossible. The bridge hardcodes `approvalPolicy: "never"` and `doStart` rejects any permission mode but `allow-all`, so no `tool-approval-request` is ever emitted and an approval host is refused pre-flight. | Supported on native and host-executed surfaces. `allow-reads` maps to Codex's `untrusted` policy; a declined command reports `declined` and does not run. |
| Attributable actions | `shell`, `web_search`. | `exec_command`, `apply_patch`, `web_search`, each with the real command and Codex's own read/list/search classification. |
| Usage | Totals. | Per turn, with cache-read, cache-write and reasoning components. |
| Interrupt / manual compaction | Neither. | `turn/interrupt` yes; manual compaction no (the shared bridge protocol has no command for it, so `doCompact` throws rather than silently doing nothing). |

Flipping the flag forks the session lane — the runtime fingerprint folds the
transport in — because a conversation started on one transport has no thread the
other can resume. Flipping back lands on the original lane.

MCP delivery stays host-executed on both. The app-server protocol has no
approval request for an individual MCP `tools/call`, so native delivery would
leave a Strict-mode host unable to gate one; that is the blocker for native
delivery, not the transport.

Protocol facts here were measured against the pinned binary rather than assumed
— see `.spike-codex-appserver/RESULTS.md`, which is rerunnable.

## Failure modes you may see

None of these fall back to the emulated engine — a turn that says it ran the
real runtime did. All fail closed; a failed start spends nothing.

| Condition | What you see |
|---|---|
| Broker delivery kill-switched (`MCPJAM_HARNESS_BROKER_DELIVERY=false`) | Pre-flight error naming the kill switch — harness runs are unavailable on that server. |
| Enterprise-managed authorization policy on the host | Pre-flight error — the harness MCP proxy can't carry the policy, so the combination is rejected rather than silently bypassed. |
| Require tool approval + selected MCP servers | Claude Code: honored. Codex on the default `exec` transport: pre-flight error — the runtime cannot pause at all; turn approval off or switch transports. Codex on `app-server`: honored, with MCPJam gating the host-executed tools. |
| Computers data plane not configured | Pre-flight error naming the data plane requirement. |
| Model not MCPJam-provided / not runnable | Pre-flight error asking you to pick an eligible model. |
| Computer at daily start cap | Start-limit dialog with upgrade CTA. |
| Org out of compute allowance + credits (enforce mode) | Computer pauses with the "Paused for billing" notice. |
| Org spending limit reached | Clean rejection at broker start (429), before any model call. |
| Sandbox dies mid-run | Turn errors; next turn starts a fresh session ("the project computer was reset"). |
