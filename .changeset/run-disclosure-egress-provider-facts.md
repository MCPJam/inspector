---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
"@mcpjam/inspector": patch
---

Show what reaches an analysis model, and what that provider may do with it, in the run disclosure.

The run disclosure types gain two optional facts under `capture.redaction`. `egress` covers what is scrubbed before any analysis model reads a transcript, and names the pipelines it does not cover. `providerRetention` covers the no-training policy sent on every platform-key analysis call, and whether zero data retention is also requested. `mcpjam eval run` prints an `Egress:` and a `Providers:` line, and the run-disclosure tooltip shows the same two lines, whenever the backend sends these facts. Older backends omit both, and then neither line is printed.
