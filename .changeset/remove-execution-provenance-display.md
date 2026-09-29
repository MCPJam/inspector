---
"@mcpjam/inspector": patch
"@mcpjam/cli": patch
---

Stop showing the "Ran on <model> via …" execution provenance line and its deviation banner. Chat turns, eval iteration details and swarm session panes no longer render it, the suite run disclosure hint drops its "Recorded (…): ran via …" line, and `mcpjam cloud eval run --wait` no longer prints the "Iteration provenance" block or the recorded-execution line under each disclosed model. Execution records are still stored and returned by the API; the SDK's formatters are unchanged.
