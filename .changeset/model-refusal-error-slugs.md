---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Stop reporting refused model choices as MCPJam failures.

The error catalog gains `provider/model_retired` and `org/model_not_allowed`. The backend `/stream` codes `model_retired` and `model_not_allowed` (HTTP 400) now map to them instead of `internal/unknown`, so a retired model, or a model the organization's provider does not allow, says what to change and no longer pages MCPJam.
