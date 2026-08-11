---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Fail closed when metadata the current MCP profile requires a client to verify is missing or unusable.

Two checks used to warn and continue, which means the flow proceeded without the protection the check exists to guarantee, and the downgrade was invisible on the wire:

- **PKCE.** An authorization server whose `code_challenge_methods_supported` omits `S256` was accepted with a `console.warn` unless `strictConformance` was set. The MCP client requirement is to verify S256 support *before* proceeding; continuing anyway is a silent downgrade. Advertising `plain` in addition to `S256` is still fine — the client picks `S256`.
- **Protected-resource metadata.** An empty or missing RFC 9728 `authorization_servers` list was replaced by the MCP server's own URL, inventing an authorization server the resource never named.

Both now stop the flow before the browser reaches an authorization server, for the eras governed by the current profile (2025-11-25 and 2026-07-28). Older eras are untouched — this is not a place to retroactively tighten a specification that genuinely said something else.

The debugger keeps the warn-and-continue behavior, because showing what a half-built server actually does is the point of pointing MCPJam at one. It gets it by passing the new `requiredMetadataEnforcement: "observe"`, an explicit non-connect intent: the default is `"reject"`, so connect, reconnect, hosted connect, and callback completion fail closed without opting in. Under `"observe"` an authorization-server substitution is recorded as an info log rather than applied silently.

The shared decision lives in `oauth/state-machines/shared/required-metadata.ts`, so the two current-era machines cannot drift apart on it.
