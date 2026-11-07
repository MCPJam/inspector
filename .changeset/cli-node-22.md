---
"@mcpjam/cli": patch
---

The CLI now requires a Node release that includes the October 2026 security fixes: 22.23.4 or later on Node 22, 24.22.1 or later on Node 24, or 26.12.1 or later. Earlier builds on those lines lack fixes such as CVE-2026-111497, a Brotli decoder bug that can allow remote code execution. The CI examples in the README and docs use Node 22, which picks up the latest patch release.
