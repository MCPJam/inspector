---
"@mcpjam/sdk": minor
---

Mock MCP servers now carry prompts, resources, resource templates, skills and MCP Apps. A definition can add, edit or hide each one, and `buildMock` serves them over the real server's own: an entry with `messages`, `text` or `blob` is the mock's, anything else is read from the real server after the host's `authorizeForward` allows it. Lists follow the real server's page size (or the definition's `pageSize`), a mock declares prompts, resources or the skills extension only when the real server or the definition has them, and an app resource's `_meta` reaches the client in the listing and in what it reads. `validateMockDefinition` no longer refuses `prompts`, `resources` or `resourceTemplates`; it checks their shape. New exports: `matchTemplate`, `templateVariables`, `listMockSkills`, `resolveMockPrompts`, `resolveMockResources`, `resolveMockTemplates`.
