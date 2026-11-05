---
"@mcpjam/sdk": patch
---

Redact credentials in the first field of a hash-route fragment. `#/access_token=…` and `#!/access_token=…` kept the token in shared reports because the segment before the first `?` or `&` was always treated as a route path.
