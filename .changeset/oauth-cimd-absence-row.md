---
"@mcpjam/sdk": patch
---

The OAuth Debugger's Authorization Server Metadata summary now shows "CIMD Supported" even when the AS omits `client_id_metadata_document_supported`, rendering it as `false (not advertised, defaults to false per spec)` — the common case for servers without CIMD support, which previously showed no row at all.
