---
"@mcpjam/inspector": patch
---

Updating a client with a config read from `GET /clients/:client` no longer fails with a 500. The read includes `localBrowserEnabled`, which the write rejected; the update now drops it like the other read-only fields.
