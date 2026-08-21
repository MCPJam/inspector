---
"@mcpjam/inspector": patch
---

Stop toasting `Missing or invalid bearer token` on every hosted /servers pageload.

`useRegistryServers` fetches the curated catalog and, after sign-in, merges leftover guest stars. Both hit Convex HTTP actions; when the hosted bearer is not attached yet they 401, and the hook toasted the raw backend message three times (catalog + merge + retry). Auth bootstrap failures are now swallowed and retried; only a real catalog/merge failure still toasts. Signing in re-fetches the catalog so `isStarred` populates once a session exists.
