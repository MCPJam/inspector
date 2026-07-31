---
"@mcpjam/inspector": patch
---

Fix the tool-approval prompt intermittently flashing and resolving before the user can answer (BUG-4). The client-driven agent loop resumes a turn via `sendAutomaticallyWhen`, whose `lastAssistantMessageIsCompleteWithToolCalls` predicate skips provider-executed parts — so a step holding an auto-fulfilled WebMCP `ui_*` tool alongside a still-`approval-requested` bash call looked "complete", and the SDK auto-resumed the turn, answering the approval for the user and unmounting the Approve/Deny buttons mid-decision. Because the predicate runs on every stream update, whether it raced ahead of the click was timing-dependent, hence intermittent.

The guarded predicate is extracted into a shared `shouldAutoResumeTurn` helper used by both the agent surface (`agent-chat-instances`) and the Playground (`use-chat-session`), so neither can auto-resume while an approval pill is still pending and the two can't drift apart. The Playground path is inert today (emulated MCP tools are never provider-executed) but is protected if a provider-executed approval ever lands there.
