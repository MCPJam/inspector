---
"@mcpjam/inspector": patch
---

A hosted conformance run that hits its time limit now records each unfinished suite as timed out. Before, a suite still stopping could save a report full of checks failed on requests the time limit cut off, so the run could end `failed` and blame the server.
