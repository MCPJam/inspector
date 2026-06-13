---
"@mcpjam/inspector": patch
---

Internal: single-source the trace/replay adaptation logic
(`evals/trace-viewer-adapter`, `chat-v2/thread/persisted-execution-replay`) from
`@mcpjam/chat-ui/trace` instead of duplicated local copies, removing drift. The
inspector keeps its eval-domain `TraceEnvelope` (spans / browser artifacts) and
bridges the package's placeholder widget/CSP types back to the real MCP-Apps SDK
types at the boundary. No behavior change.
