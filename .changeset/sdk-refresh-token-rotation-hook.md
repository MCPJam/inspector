---
"@mcpjam/sdk": minor
---

Report a rotated OAuth refresh token to the caller, via a new `onTokensRotated` option on an HTTP server config.

Most authorization servers issue single-use refresh tokens, so the value passed as `refreshToken` is spent once it has been exchanged. The SDK kept the replacement in memory, which is invisible inside one process and fatal across processes: a CI job or any other long-lived caller configured from a secret authorized once and then failed, with nothing to say a credential had been silently replaced.

`onTokensRotated` receives the replacement so it can be persisted back to wherever the original came from. It fires only when the token actually changed, and a handler that throws or rejects never fails a connection that has already authorized.

The documented behaviour in `docs/sdk/concepts/connecting-servers.mdx` was also corrected: it claimed the SDK "stores rotated refresh tokens" without saying that the store dies with the process.
