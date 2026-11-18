---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Conformance checks no longer fail a server for behavior the MCP spec allows. A modern server may advertise `resources.subscribe`, stay silent after a client opts into logs, omit its server identity, close a subscription stream without a completion response, or answer `input_required` with only `requestState`. Wire Schema Valid accepts an `input_required` answer to `tools/call`, `resources/read` and `prompts/get`. Legacy runs finish the handshake before the concurrent POST and SSE probes and no longer assume the server has tools. The OAuth stale-session check now ends a real session and requires HTTP 404. Legacy Tasks accepts `ttl: null`, requires a TTL, and accepts a `tasks/result` that forwards the original JSON-RPC error. MCP Apps reports the recommended MIME type on a listed UI resource as a warning.
