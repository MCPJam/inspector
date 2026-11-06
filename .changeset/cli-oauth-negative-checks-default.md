---
"@mcpjam/cli": patch
---

`oauth conformance`, `oauth conformance-suite` and `conformance run --suite oauth` now always run the OAuth negative checks (invalid client, mismatched redirect, invalid token and more), as the Inspector UI does, so the CLI and the UI give the same score. A server that wrongly accepts bad input can now fail where it passed before. `--conformance-checks` is deprecated: it is still accepted and does nothing. A suite config file that sets `oauthConformanceChecks: false` still turns the checks off.
