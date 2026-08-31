---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

A registration endpoint answering 4xx is the server under test declining, not an MCPJam defect

The OAuth debugger reported every Dynamic Client Registration failure to Sentry. A 4xx from the registration endpoint is the authorization server declining to mint a client — DCR left unimplemented behind an advertised `registration_endpoint`, an allowlist, an initial access token the client was never given, or metadata the server will not accept. The debugger exists to show that; filing it as a bug against MCPJam is the same noise the client-side origin policy already removes everywhere else.

`isClientRegistrationRefusal` classifies those 4xx messages. 5xx and transport failures are deliberately not refusals: those can be the debug proxy failing, which is ours. 4xx is read as the server's policy knowingly rather than because it always is — RFC 7591 also spends `invalid_client_metadata` on a body the client built wrong, but in practice that code comes back for a valid body the server declines, and the request builder is covered by its own unit tests rather than by this signal.

One rejection also produced two reports. The machines write the bare message, then the same message with the fallback hint appended once no pre-registered client turns up, and the debugger's dedup guard keys on the string. `restatesWithFallbackHint` pairs them by matching the hint exactly rather than by prefix — a prefix rule would have swallowed `Token request failed: 400 Bad Request` followed by the same line carrying `invalid_grant`, which is a more informative failure and not a duplicate.

Both messages still render in the debugger. Only the Sentry issue goes away.

`REGISTRATION_FAILURE_PREFIX` is now exported and read by `trace.ts`, which previously repeated the literal, so a rewording cannot leave the recovered-fallback check matching stale text.
