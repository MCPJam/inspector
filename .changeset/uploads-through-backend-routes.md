---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Send upload bytes through MCPJam's upload routes (MJ-006).

`reportEvalResults` now sends widget HTML that is too large to report inline to `POST /api/v1/projects/:projectId/eval-ingest/artifacts` as raw bytes with its own `Content-Type`, and reads back the storage id. 429 and 5xx answers retry on the same schedule as every other ingestion call, honouring `Retry-After`; an upload that still fails keeps the widget inline, as before.

The inspector serves that route, and its widget snapshots, saved views, eval attachments, skill supporting files, screenshots, replay videos and browser profile archives now send their bytes to routes that store them and answer with a storage id. Eval attachments over 19 MB and skill supporting files over 2 MB are refused with a clear message before anything is uploaded.
