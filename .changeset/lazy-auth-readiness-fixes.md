---
"@mcpjam/sdk": patch
---

Fix several lazy-authentication and OAuth discovery edge cases:

- OAuth conformance no longer accepts Protected Resource Metadata whose `resource` is blank as the server's own metadata.
- Claude readiness reports lazy authentication as confirmed only when the protected call answered HTTP 401 with a `Bearer` challenge, which is what Claude acts on.
- OpenAI readiness treats an HTTP 401 on the protected call as a sign-in request even when no challenge could be parsed, and no longer reports lazy authentication as unsupported when the anonymous `initialize` failed for a reason other than HTTP 401 or 403.
- Server doctor no longer says a server allows anonymous access when the run supplied credentials; it says OAuth metadata was found.
- OAuth discovery no longer fails when the Protected Resource Metadata document is `null` or names no usable authorization server: it uses the server origin as the authorization server, and a document that is an object keeps its `resource`.
