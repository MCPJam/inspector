---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Stop reporting oversized guest requests as MCPJam failures.

The error catalog gains `account/guest_input_too_large`. The backend `/stream` code `guest_input_too_large` (HTTP 413) now maps to it instead of `internal/unknown`, so a guest whose request is over the input limit is told to sign in or send less, and the refusal no longer pages MCPJam.
