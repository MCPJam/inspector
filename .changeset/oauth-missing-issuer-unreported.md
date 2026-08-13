---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Stop reporting missing-issuer metadata failures as MCPJam errors.

RFC 8414 makes `issuer` REQUIRED, and every debug OAuth machine rejects an authorization-server metadata document that omits it. That check stays, and the message stays on screen — but it describes a spec violation in the server under test, not a fault in MCPJam, and only the 2026-07-28 machine reads the field afterwards (it compares the issuer to the authorization-server URL and to the callback `iss`). On the other three eras the failure was arriving as an MCPJam alert, burying real step failures under other projects' bugs.

The step-failure reporter now skips it, alongside the `Warning: `-prefixed advisories it already skipped, and treats it the same way for recurrence: it still replaces the previous message, so a genuine failure that follows one counts as new.

The SDK exports `AUTHORIZATION_SERVER_METADATA_MISSING_ISSUER` and the machines throw it, so the match cannot drift out of sync with the message they actually produce.
