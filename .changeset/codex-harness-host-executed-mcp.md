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

Scope step-up (SEP-2350) is carried on this path too. A host-executed call never
touches the signed proxy that extracts an `insufficient_scope` challenge on the
native path, so the projected tools observe it in-process with the same shared
extractor and publish into the same turn-level bridge. A hosted-OAuth server that
needs a step-up therefore pauses a Codex turn and offers re-authorization, rather
than reporting an ordinary tool failure to the model.

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
