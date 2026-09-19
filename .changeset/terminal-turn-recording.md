---
"@mcpjam/inspector": patch
---

Record turns that ended abnormally, behind `MCPJAM_TERMINAL_TURN_RECORDING` (off until the control plane can store the record). A cancelled, failed or timed-out turn is persisted with its open tool calls closed and a record of how it ended, so the steps that already ran — and were already billed — leave a durable trace instead of nothing. Paused turns are excluded: their dangling call is the resume handle.

The v1 API's partial-turn persist no longer requires a browser to be attached, and its inline `finishReason` guess is replaced by the engine's own record wherever one exists.

The ingress guard now tells the client about a call it closed, so a browser that sent an open call resolves its spinner instead of hanging until a reload.
