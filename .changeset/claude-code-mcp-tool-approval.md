---
"@mcpjam/inspector": patch
---

Claude Code can now pause for approval on MCP-server tool calls, instead of the run being refused

An approval host with any MCP server selected was refused outright on the Claude Code harness — in chat, in evals, and in swarms — with "the Claude Code harness can't pause for approval of MCP-server tools". That refusal rested on a belief that turned out to be wrong: that the CLI's own MCP client called those tools from inside the sandbox with nothing for MCPJam to interpose on.

There is an interposition point, and it always covered MCP tools. The adapter's in-sandbox bridge routes **every** tool call through a `canUseTool` callback before the CLI may run it, emits `tool-approval-request` over the bridge socket, and waits for the host's decision. Which calls reach that pause is decided by the bridge's own tool-kind table, and the load-bearing detail is its default: a tool name it does not recognize is treated as kind `edit`. An external MCP tool (`mcp__<server>__<tool>`) is never in that table, so it pauses under the `allow-reads` permission mode and runs free under `allow-edits` — which is the mode MCPJam was selecting. The capability was one enum value away the whole time.

So `approvalPermissionMode` for Claude Code moves to `allow-reads` and `supportsMcpToolApproval` becomes true. Nothing changes for a host that has not asked for approval; that path still runs `allow-all`.

**The trade-off worth knowing about.** `allow-reads` widens the prompt surface: native edit-class built-ins (Write, Edit, NotebookEdit, TodoWrite, the Task family) now prompt too, where `allow-edits` let them through and only Bash paused. Reads still never prompt, which keeps the faithful mapping to the emulated engine — it gates tool calls, never reads. There is no mode that pauses on MCP tools and not on native edits, so this is the price of the capability rather than a separate choice.

**Codex is unchanged, and this is why.** Its adapter builds the Codex thread with `approvalPolicy: "never"` and `sandboxMode: "danger-full-access"` hardcoded, so Codex is never asked to pause on anything and no approval request is ever emitted. It drives `codex exec`, a batch mode with no channel to interrupt; the interactive `codex app-server` transport that could carry approvals is not what the AI SDK adapter speaks. An approval host on Codex is still refused, now with that reasoning recorded next to the flag.

**The gate itself is unchanged and still bites.** Claude Code satisfying it is a fact about the adapter, not a reason to stop checking: a native-delivery harness that cannot approve its MCP tools is still refused the moment a server is attached, and that is now asserted directly rather than through whichever harness happened to refuse.

That last point cost some coverage elsewhere, and the fix is worth noting. Several tests asserted the rule "plugin-contributed servers count toward the approval gate" **through** the Claude Code refusal, so they went vacuous the moment the refusal did — one of them kept passing for the wrong reason. The rule was also inlined in three places. It is now one exported helper that all three call, unit-tested directly, and the swarm-level test proves the fail-closed direction with an adapter stub. Both plugin-counting tests were confirmed to fail when the rule is deliberately broken.
