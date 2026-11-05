---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

Let the log level filtering advice call its own tool through the new `logLevelFilteringProbe` option, falling back to `logProbe`. In the inspector, every conformance check that calls a tool now shows its tool dropdown, filled with the shared tool until you pick a different one.
