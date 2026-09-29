---
"@mcpjam/cli": minor
---

Add `mcpjam cloud feedback`: tell the MCPJam team about MCPJam itself (a bug, a missing capability, something confusing) from the terminal. Your text is sent to the MCPJam team (outside your organization) and stored for 180 days. `--kind` and `--summary` are required; `--details` (or `--details-file`, `-` for stdin) takes what you were trying to do, what you expected and what blocked you. `--project` is sent only when named: the command never picks up a linked project or `MCPJAM_PROJECT`. Pass `--idempotency-key` to make a retry return the original receipt instead of filing twice.

When a Cloud command fails with an internal error or a missing capability and the response carried a request id, the error message now ends with a ready-to-run `mcpjam cloud feedback --kind … --request-id <id> --summary "…"` command. Gateway failures (502/503/504), client errors, and `cloud feedback` itself never suggest it.
