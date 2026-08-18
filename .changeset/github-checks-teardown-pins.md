---
"@mcpjam/inspector": patch
---

Pin the GitHub PR check sandbox's orphan backstop in tests. A dead worker's box is reaped by E2B's own TTL, so the `timeoutMs` and `lifecycle: { onTimeout: "kill" }` provisioning options are what actually guarantee teardown — and neither was asserted, so dropping `lifecycle`, or switching it to `pause` (which would snapshot a pull request's build rather than destroy it), would have passed CI. Also asserts that no MCPJam credential material reaches the box, that a missing dedicated template fails rather than falling back to the shared computer image, and that a failed kill stays best-effort.
