---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Conformance checks that only need a tool picked in setup no longer make a run incomplete. They still show as needing input, and a run whose only gaps are these checks now passes.
