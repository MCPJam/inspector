---
"@mcpjam/inspector": patch
---

Preserve live MCP App surfaces, state and tool aliases when a concurrent chat history write conflicts and continues in a local fork. Keep Playground render overrides on that continuation while isolating ordinary new chats and history switches, including reopening the source history after a fork.

Keep the user App tools rail bound to the same live App lifetime as model calls, while browser and persistence identities follow the durable conversation. Preserve unsnapshotted injected render metadata only for surviving calls during same-lifetime history refresh, and reset copied tool editors on manual branches.

Keep the selected App tool, form draft and completed result when the same App lifetime becomes read-only. Cancel pending execution without clearing detail state, and allow execution again after write access returns.

Preserve the revealed trace and single chat pane through conflict forks even with comparison configured, resolve Harness App calls against the retained App lifetime, and discard queued context for Apps removed by a history refresh.
