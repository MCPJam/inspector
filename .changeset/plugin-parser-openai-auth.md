---
"@mcpjam/sdk": minor
---

Under the `openai-compatible` profile, an MCP server entry may carry `extensions["com.openai"].auth`, which `parsePluginBundle` reads into a typed `auth` descriptor (`none`, `oauth`, `mixed` or `api_key`) through an allowlist of OpenAI's documented fields: endpoint overrides must be absolute HTTPS URLs without credentials or fragments, credentials are never stored, and an invalid declaration skips only its server. OAuth setup requirements now say whether sign-in is `required` (`mixed` also serves public access), an API key becomes a secret header requirement carrying its `scheme`, and `renderPluginApiKeyHeader` builds the header from a supplied credential without doubling a `Bearer` or `Basic` prefix. The strict profile keeps the closed entry schema.
