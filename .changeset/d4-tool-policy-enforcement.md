---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Enforce eval tool policies at execution time with visible-but-blocked tools,
recording policy blocks without treating them as eval failures. Hosted
platform-authored suites still lack the backend policy field and remain
unsupported by the hosted CLI.
