---
"@mcpjam/sdk": minor
---

host-config: add `normalizeSdkEvalHostConfigForWire` (Stage 5 helper, `/internal` only).

Strips runtime-manager identifiers (`serverIds`, `optionalServerIds`, `serverConnectionOverrides`) so SDK eval reporters and backend ingestion hash byte-identical wire shapes. Accepts either `HostConfigInputV2` or `HostJson` (Host.toJSON()). Reporter wire-send is gated behind backend capability (Step 3, later PR).
