---
"@mcpjam/inspector": patch
---

The agent turn advertises Skills over MCP, so a server that serves skills is visible to it

MCPJam serves Agent Skills over SEP-2640 and verifies them on the way in — but its own hosted agent surface (`send_chat_message` / the `/v1` chat turn) could never see one. Driving the playground against a skills-serving server returned `advertisedToolCount: 0`, and the model answered that it had no tool-calling interface at all: `withServerSkills` filters to extension-active connections, the hosted connection advertised nothing, so no `listSkills` / `loadSkill` was ever merged. A server that serves skills was indistinguishable from one that does not.

`withSkillsExtensionCapability` had exactly one call site — the LOCAL connect path.

The declaration is opt-in rather than blanket, because most hosted connections **emulate a third-party host** and the debugger's whole promise is that the wire shows what that host would send; advertising skills on an emulated Cursor persona would be a lie about Cursor. The agent turn emulates no persona, pins no host config, and ships the fulfiller (`prepareChatV2` merges `withServerSkills`, which loads only through the verified read path in `server-skills.ts`), so advertise = enforce is satisfied there and nowhere else changes.

It is set on the manager's **defaults**, not on per-server `clientCapabilities`. The latter takes `MCPClientManager`'s exact-set branch and is advertised verbatim: since the default set declares `io.modelcontextprotocol/ui`, routing the extension through it would have silently stopped the agent turn advertising MCP Apps and lost widget rendering. It would also have overridden any host config that pinned its own capability set. Defaults merge; a pinned exact set still wins.

Tested with that concrete regression pinned — the capability object alone carries skills and not `ui`, and the merged result carries both.
