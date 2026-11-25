---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
"@mcpjam/inspector": patch
---

Expired CLI update notices now refresh silently instead of advertising an outdated version, and the install hint explicitly requests the latest release. Eval run pages flag recorded CLI versions before 6.4.1, whose local HTML and JUnit reports can omit iteration evidence. New online eval launches and report uploads from identified older MCPJam CLIs return an upgrade message before creating a run.
