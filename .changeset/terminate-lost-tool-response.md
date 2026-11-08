---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

End pending tool requests when their HTTP response stream is lost without a final response, preserving resumable streams and ordinary reconnects.
