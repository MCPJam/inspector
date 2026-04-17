---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Inline the SDK version at build time instead of `require("../package.json")` in `sentry.ts`. The previous code used `createRequire(import.meta.url)` which broke for consumers that bundle the SDK (e.g. the inspector's server tsup config uses `noExternal: ["@mcpjam/sdk"]`) — the `require` resolved relative to the consumer's bundle, where no `package.json` lives. tsup's `define` now replaces `__MCPJAM_SDK_VERSION__` with a string literal at SDK build time, so the version survives re-bundling.
