---
"@mcpjam/inspector": patch
---

The hosted chat turn records the system prompt it actually sent

`persistChatSessionToConvex` has two prompt fields, and they answer different questions: top-level `systemPrompt` is EVIDENCE of what the model was given, and `resumeConfig.systemPrompt` is what a RESUMED turn replays. The local route (`routes/mcp/chat-v2.ts`) and the agent-turn route both fill the first with the enhanced prompt. The hosted Playground route filled only the second — so the record of a hosted turn carried the bare host prompt and none of what the turn added: the server-skill catalog, widget model context, the environment block.

That matters most for the thing skills over MCP just shipped. "Did the model even know that skill existed?" is the first question anyone asks when an agent ignores a skill, and it is answered by the catalog being in the prompt or not. A record that cannot show the catalog cannot answer it.

The two fields stay separate, deliberately. Turn-injected content is true of the turn that happened and not of the next one — replaying "your sandbox was reset" long after the fact, or a skills catalog for servers no longer connected, is exactly the confabulation the raw resume prompt exists to prevent. Both fields already existed on the ingest contract; only the hosted writer was leaving one empty.
