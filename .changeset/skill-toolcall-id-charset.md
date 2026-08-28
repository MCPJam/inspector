---
"@mcpjam/inspector": patch
---

Directly loading a server-served skill no longer breaks the rest of the conversation

Attaching a skill from the picker injects a synthetic `loadSkill` tool call into the transcript, and that call's id is replayed to the provider on every later turn. The id was built as `skill-load-${skill.name}-${generateId()}`.

A server-served skill (SEP-2640) is addressed by a namespaced `<server>/<skill>` ref, so the id carried a `/`. Anthropic validates `tool_use.id` against `^[a-zA-Z0-9_-]+$` and rejects the whole request otherwise — so the next message failed with `messages.5.content.1.tool_use.id: String should match pattern '^[a-zA-Z0-9_-]+$'` and the conversation could not be continued at all. The load itself had already succeeded; it was the turn after it that died.

Cloud and local skills are plain slugs, which is why the id survived unsanitized until server skills put a separator in the name.

The name is in the id for debuggability only — `generateId()` supplies the uniqueness — so the offending characters are replaced rather than dropped, keeping the id readable. Sanitizing happens at the one place ids are minted, not by narrowing refs upstream: the ref's shape is the namespacing contract the picker and `loadSkill` both compute, and bending it to one provider's id rules would make two unrelated concerns share a format.
