---
"@mcpjam/inspector": patch
---

Server-served skills are named in the prompt, so the model can actually choose one

Progressive disclosure has three levels: every skill's **name and description** are always in context, the `SKILL.md` body loads when the model judges it relevant, and supporting files load after that. Level 1 is never lazy — a model cannot choose a skill whose description it has never read.

The server-skills stanza skipped it. It said *"call `listSkills` to see those"* and named nothing, so picking a skill meant guessing that a relevant one might exist and spending a tool call to find out. Most turns never did. Asked how to import a corpus of promptfoo tests — with `mcpjam-eval-import` connected and its description matching almost word for word — the model never called `listSkills` and improvised a conversion process instead.

That is the irony of the old shape: `skills/list` **is** the progressive-disclosure mechanism. SEP-2640 returns frontmatter separately from content precisely so a host can put the catalog in front of the model without fetching a single body. We implemented that wire correctly and then called it lazily, discarding the thing it was designed for.

The catalog is now rendered into the system prompt, budgeted and formatted with the same helpers the Cloud Skills catalog uses — so the two halves of one feature cannot drift on wording, sort order, or what happens when metadata outgrows its share of the context. Each line keeps its origin (`MCP server "…"`), because these descriptions are third-party text and one that reads like an instruction should still show who wrote it. Unloadable skills stay listed and marked rather than hidden, so the model stops retrying them and a server author can see MCPJam declined.

The stanza also leads with what to do and follows with how to distrust it. The trust wording is unchanged and still unconditional — a digest match shows the bytes are consistent with what the server advertised, which is not the same as the content being trustworthy — but it no longer buries the only actionable sentence under three warnings.

Cost is one `skills/list` per turn per declaring server, shared with any `loadSkill` in the same turn, and the same per-turn catalog fetch Cloud Skills already pay. Caching it against the `ttlMs` servers already send — the worker serves an hour, and we currently surface that TTL and ignore it — would remove even that, and is worth doing for both paths at once.
