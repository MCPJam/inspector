---
"@mcpjam/sdk": minor
---

`run_eval_suite` takes `serverReplacements`: run an environment suite with one of its servers replaced, by name, by another saved server (usually a mock). The run keeps the real server's name, so a step pinned to it reaches the replacement, and records the replacement, the mock's version and a hash of the real server's listing.
