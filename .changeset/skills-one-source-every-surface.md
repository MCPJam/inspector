---
"@mcpjam/inspector": minor
---

Skills come from one catalog now, not four disconnected ones

A chat turn used to resolve its skills through an exclusive chain — project skills, or nothing, or the local filesystem — and which arm you got was decided by DEPLOYMENT rather than by what you had. That is why you could author a project skill in the Skills tab on desktop and then have no way to use it: authoring wrote to Convex, and the desktop turn only ever read the local filesystem.

Where a skill comes from is a property of the skill, not a mode the app switches between. A turn now merges every origin available to it into one ref-addressed catalog:

| Origin | Reference |
|---|---|
| Your project | `code-review` |
| A local file | `local/code-review` |
| A connected MCP server | `<server>/code-review` |
| A plugin | `<plugin>/code-review` |

So a desktop turn signed into a project offers your local files **and** your project skills, and a skill you author is usable in the very next message. Signed out, it offers local files exactly as before.

Two skills sharing a name are no longer a conflict to resolve by luck. Both appear, both load by their own reference, and a bare name that more than one origin answers to is refused with the alternatives named rather than silently resolved to whichever was indexed first.

**The v1 agent turn — and `send_chat_message` with it — sees project skills for the first time.** It could already read a connected server's skills; its own project's pool was invisible, so an agent driving MCPJam could read somebody else's skills but not yours.

Two things worth knowing:

The Skills tab's Local/Cloud switch now only changes what you are **browsing**; it does not decide what a turn can use. It is also gated on the Skills flag rather than `computers-enabled`, which was a leftover from when cloud skills lived on a Computer's filesystem — wrong in both directions, since it could offer a store the backend would refuse to write, or withhold one you had.

Project skills stay lazily fetched: a turn costs one catalog query, and a skill's body is fetched only when the model actually loads it. A 200-skill project does not pay 200 fetches to build a listing.
