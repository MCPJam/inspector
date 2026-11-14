---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Stop reporting a model with no private provider as an MCPJam failure.

The error catalog gains `provider/no_zdr_endpoint`. The backend `/stream` code `policy_no_zdr_endpoint` (HTTP 422) now maps to it instead of `internal/unknown`. The code is returned when a request needs a provider that keeps no data and doesn't train on it and the model has none. The user is told to choose another model, and neither the chat turn nor the hosted eval turn pages MCPJam.
