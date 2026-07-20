---
"@mcpjam/sdk": minor
---

New `@mcpjam/sdk/plugin-bundle` export: a pure, source-adapter-independent parser for OpenAI plugin bundles. Additive: no existing exports change.

- `parsePluginBundle(source)` consumes the abstract `PluginFileSource` interface (no filesystem, no archive libraries, zero Node builtins) and returns the normalized manifest, skills, MCP server configs, app metadata, assets, unsupported components, setup requirements, and validation warnings.
- Accepts all three MCP config shapes (direct server map, `mcp_servers`, `mcpServers`) and normalizes to one discriminated stdio/http union; `${PLUGIN_ROOT}`-style placeholders are preserved verbatim, never substituted.
- Full archive-path defense (absolute paths, `..` traversal, NUL bytes, duplicate/case-fold collisions, symlink markers, length/depth/count limits) with stable issue codes; hostile bundles fail before any file content is read.
- Deterministic bundle/manifest/component hashing via the SDK's existing portable `crypto.subtle` helpers — identical across Node and browser, listing-order independent.
- Secret hygiene: env/header requirement names only; literal values are dropped with warnings. Unknown/extension fields and oauth metadata are recursively sanitized at every depth (secret-looking keys AND secret-looking string values are dropped before anything reaches a stored DTO or hash input), `${PLUGIN_ROOT}` templates are only preserved when the value is a pure path template, and hostile deeply-nested values fail with a stable `VALUE_TOO_DEEP` code instead of a stack overflow.
