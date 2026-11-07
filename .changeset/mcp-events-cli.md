---
"@mcpjam/cli": minor
---

`mcpjam events` subscribes to a server's MCP Events and prints them as NDJSON. It covers `list`, `poll`, `watch` (poll, push or webhook), `subscribe`, `unsubscribe` and `conformance --profile draft|chatgpt`. Webhook secrets are never printed, and a plain-http receiver is labelled as a non-conformant development mode.
