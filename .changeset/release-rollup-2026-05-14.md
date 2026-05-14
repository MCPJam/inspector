---
"@mcpjam/inspector": patch
"@mcpjam/sdk": minor
---

Inspector + SDK rollup since the last release.

**@mcpjam/sdk**

- Consume `hostConfig.mcpProfile` end-to-end: profile-aware connection in `MCPClientManager`, new sandbox-policy types, and supporting browser/index exports (#2103).

**@mcpjam/inspector**

- Named hosts UI: new Hosts tab, HostPicker, host builder, and consumer seeding (#2112).
- Host config: consume `hostConfig.mcpProfile` end-to-end across chatbox, hosted chat, and server connection paths (#2103).
- Billing: surface pending and failed credit top-ups in the credit balance card (#2111).
- Electron OAuth: redirect-mixing fix between dev and local (#2116), plus an Electron fallback path for the OAuth modal/sidebar/auth flow (#2096).
- Tokenizer: stop paging Sentry for client-side fetch failures (#2109).
- Docs: desktop download links now point at the latest release URLs (#2093).
- Misc sidebar nit.
