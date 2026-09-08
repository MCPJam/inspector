---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Server facts: what the run was taken against, beside the run

A versioned contract, a computed-on-read backend query, a v1 route and a card
under the run's stage strip. Connection and Discovery stop saying "observed by
the runner" and start saying what was observed: connect outcome and time, the
tool surface, its size, its annotations, and the deterministic metadata signals
per tool.

Three payload sizes exist for a server and this keeps them apart: the catalog
as the client assembled it (measured at capture, before the snapshot
transform), the bytes we retained, and what the model saw — which is a host
fact and is not in this document. Every byte count carries its basis; every
token number is labelled an estimate against a reference window.

Conformance and readiness runs are linked, never graded: the join is by server
id alone, and each row carries its own timestamp and says so.
