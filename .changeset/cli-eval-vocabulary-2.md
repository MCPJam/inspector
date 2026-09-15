---
"@mcpjam/cli": minor
---

`eval run --file` and `eval export` speak eval vocabulary 2 when the
deployment advertises it.

Each command asks `GET /capabilities` once; if the deployment advertises
`vocabulary.version: 2` the CLI derives a client that sends
`x-mcpjam-eval-vocabulary: 2` and writes case bodies under the canonical
names — `iterations` (the exact count), `legacyIterations` (the legacy floor,
the same number, which is what the legacy resolver would have floored to) and
`assertions` — instead of `repetitions` / `iterations` / `checks`. Responses
under vocabulary 2 are projected onto the CLI's existing case and suite model
at the one place the wire is read, so nothing downstream changes.

A deployment without the capability block, or without the capabilities route
at all, is a vocabulary-1 deployment and the CLI's bodies are byte-for-byte
what they were. The platform MCP server and the `eval cases` / `eval suite`
JSON commands stay on vocabulary 1.
