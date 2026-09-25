---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
"@mcpjam/inspector": patch
---

Show what an analysis provider may keep in the run disclosure.

The run disclosure types gain an optional `capture.redaction.providerRetention` fact: the zero-data-retention and no-training policy every platform-key analysis call sends, and what it does not cover. `mcpjam eval run` and the run-disclosure tooltip print an `Analysis providers:` line read off those flags whenever the backend sends the fact. Older backends omit it, and then no line is printed.
