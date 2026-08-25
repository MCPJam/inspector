---
"@mcpjam/inspector": minor
---

Codex hosts can now use the host's selected MCP servers.

The Codex CLI does not make an MCP server's tools model-callable in the mode the
SDK drives (`codex exec --experimental-json`) — the handshake completes and
`tools/list` answers, but nothing becomes callable (openai/codex#19425). Writing
`~/.codex/config.toml` merges cleanly and is a silent no-op, so MCPJam does not
write it. Instead, each selected server's tools are enumerated at turn start and
handed to the agent as **host-executed** tools, which the harness bridge relays
back out of the sandbox and MCPJam executes in-process against the already
authorized `MCPClientManager`.

The adapter's `supportsSelectedMcpServers: boolean` is replaced by
`mcpDelivery: "native" | "host-executed"`, a discriminated union in which only
the native arm may carry `deliverMcpServers` — so the two paths are mutually
exclusive by construction and the model can never see the same MCP tool twice.
Projected tools are named `mcp__<server>__<tool>`, exactly as Claude Code names
them, so traces and eval assertions attribute identically across the two
harnesses. The `mcp-servers` pre-flight refusal (which blocked every Codex host
with a server attached, and therefore every Codex eval suite) is gone; a Codex
host that requires tool approval is still refused, because Codex cannot pause a
host-executed tool.

What the model sees is the tool's own **model-facing projection**, not the raw
MCP result. The harness host-tool loop submits whatever `execute()` returns and
never calls `toModelOutput`, so a projected MCP App tool would have shipped its
client-only `_meta` and `structuredContent` straight into the model's context —
token cost and context leakage for a payload a harness cannot render at all —
and would have bypassed the host's `modelVisibleMcpToolResults` policy. The
relay now carries the projection while the raw result is kept for the UI, the
trace and the transcript, so a Codex turn still shows what the server actually
returned.

The projection also runs under the **host's own tool-construction options**, not
the SDK's defaults. `getToolsForAiSdk` states outright that it will not read a
host config itself, so anything the caller does not pass is not defaulted — it is
gone, and a Codex turn was projecting results under a `modelVisibleMcpToolResults`
policy the host never chose. `respectToolVisibility` (SEP-1865 app-only tools)
and the resolved MCP Tasks seam were dropped the same way, which made two
host-level policies mean something different on host-executed delivery than on
every other engine. All three now travel through one shared builder that the
emulated engine and both eval runners use as well, so a surface that forgets a
field forgets it in one visible place rather than silently at its own call site;
with nothing set it still answers "no options", so a default turn's tools are
byte-identical. `needsApproval` is deliberately not in that set on this path:
host-executed approval is enforced by the harness agent's own `toolApproval` map
(and refused outright for a runtime that cannot pause), while the AI SDK flag is
read only by the emulated loop — passing it would add a second, inert approval
declaration that reads like enforcement.

Scope step-up (SEP-2350) is carried on this path too. A host-executed call never
touches the signed proxy that extracts an `insufficient_scope` challenge on the
native path, so the projected tools observe it in-process with the same shared
extractor and publish into the same turn-level bridge. A hosted-OAuth server that
needs a step-up therefore pauses a Codex turn and offers re-authorization, rather
than reporting an ordinary tool failure to the model. The turn correlates a
challenge to its tool call by `toolCallId` when the publisher has one, falling
back to the (server, tool, input) tuple only for the proxy, which has no id to
give — two identical calls in one turn used to resume the first, whichever one
actually failed.

`toolPolicy` admission is delivery-aware. It used to refuse any policied harness
run on a deployment that could not seal the policy into a proxy token, which
wrongly refused every policied Codex eval on a deployment whose terminal secret
was merely too short — host-executed delivery mints no such token and enforces
the snapshot in-process. Native delivery still fails closed exactly as before.

Tool-approval refusals no longer depend on whether MCP servers happen to be
selected. The pre-flight and the in-turn backstop now ask one shared helper, so a
runtime that cannot pause on its own native tools is refused under
`requireToolApproval` either way — closing a gap where an eval or synthetic run
(which skips the pre-flight) could execute host-executed built-ins unapproved.

Fidelity caveat: this is not equivalent to Claude Code's native MCP client. The
bridge injects each tool's description into the prompt and the model invokes
them through a CLI shim, so tool-selection behavior differs from a native MCP
client, and the tools run on MCPJam's server rather than in the sandbox. Tool
schemas are read once per turn — there is no `tools/list_changed` subscription.
