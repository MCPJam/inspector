---
"@mcpjam/sdk": patch
---

The bundled Codex and Copilot host templates now match the 2026-10-12 probes. Both connect at protocol 2026-07-28. Codex sends `openai-mcp (Codex)` 1.0.0, follows `nextCursor`, allows clipboard write and offers form elicitation only. Copilot sends `Sydney` 1.0.0 with hostInfo `M365Copilot` 1.0.0, allows clipboard write and advertises serverResources, logging and downloadFile.
