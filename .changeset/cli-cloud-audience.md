---
"@mcpjam/cli": major
---

Cloud commands print a stderr audience line (`Using MCPJam Cloud as … · … · …`) before the operation and fail immediately when no credential is configured. `--quiet` suppresses the line; machine-readable stdout stays unchanged. Hosted `readiness` does not print Cloud audience context.
