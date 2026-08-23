---
"@mcpjam/inspector": patch
---

Add an agent-facing skill for mapping existing promptfoo, pytest, Jest, and CSV
tests into versioned MCPJam eval suite files.

The skill treats source repositories as untrusted data, requires a cited
structural rule before an imported case can claim `exact`, disables non-exact
cases pending review, and drives the offline `eval validate` repair loop. A
worked promptfoo conversion and CLI regression keep its canonical output valid.
