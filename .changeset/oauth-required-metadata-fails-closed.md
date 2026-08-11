---
"@mcpjam/sdk": major
"@mcpjam/inspector": patch
---

Fail closed when metadata an MCP authorization profile requires a client to verify is missing or unusable.

Two checks used to warn and continue, which means the flow proceeded without the protection the check exists to guarantee, and the downgrade was invisible on the wire:

- **Protected-resource metadata.** An empty or missing RFC 9728 `authorization_servers` list was replaced by the MCP server's own URL, inventing an authorization server the resource never named. Now an error from **2025-06-18** onward — that revision already required the PRM document to "include the `authorization_servers` field containing at least one authorization server," and 2025-11-25 and 2026-07-28 repeat it verbatim.
- **PKCE.** An authorization server whose `code_challenge_methods_supported` omits `S256` was accepted with a `console.warn` unless `strictConformance` was set. Continuing is a silent downgrade to a weaker code challenge method, so the flow now stops. Gated at **2025-11-25**, because 2025-06-18 says nothing about `code_challenge_methods_supported` and inventing a rule it does not state would make that machine unfaithful to its era. Advertising `plain` in addition to `S256` is still fine — the client picks `S256`.

The two gates are deliberately different, and each is scoped to the eras whose spec text actually states the requirement. Gating both at 2025-11-25 would have left the version selector as a one-click bypass: a user blocked by the PRM check could pick 2025-06-18 and connect anyway, against a revision carrying the same MUST. 2025-03-26 predates the profile's adoption of RFC 9728 and keeps the historical fallback.

The debugger keeps the warn-and-continue behavior, because showing what a half-built server actually does is the point of pointing MCPJam at one. It gets it by passing the new `requiredMetadataEnforcement: "observe"`, an explicit non-connect intent: the default is `"reject"`, so connect, reconnect, hosted connect, and callback completion fail closed without opting in. Under `"observe"` an authorization-server substitution is recorded as an info log rather than applied silently.

Both gates live in `oauth/state-machines/shared/required-metadata.ts` and are consulted by every era's machine, so a machine cannot drift from its era's policy and a new era file cannot silently omit the check.
