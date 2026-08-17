---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Keep OAuth diagnostics visible when a server advertises a metadata URL that is not absolute — the protected-resource URL or an authorization-server endpoint — and when it rejects an authorization code with `invalid_grant`. The sequence diagram now marks the unparsable value instead of crashing, and the token-exchange error keeps the authorization server's own explanation.
