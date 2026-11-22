---
"@mcpjam/sdk": patch
---

An unpinned HTTP connection no longer falls back to the older HTTP+SSE transport after the server answers with the modern "protocol version not supported" error (`-32022`). That error identifies a modern server. When the server lists a 2025 version, the client retries once with the 2025 handshake and connects. Otherwise it fails with a message that names what the server offers, in place of the old combined "Streamable HTTP error … SSE error … (405)". A server that never sent that error still gets the SSE fallback. `ModernProtocolVersionRefused` is exported for callers that want to catch it.
