---
"@mcpjam/inspector": minor
"@mcpjam/cli": minor
---

Name the tools the 2026-07-28 protocol checks may call, so a 2026 server can finish a conformance run. On the Conformance page, pinning 2026-07-28 shows a **Probe tools** button: pick the tool that emits logs and the tool that asks for input from the server's own list, with optional JSON arguments. Read-only tools are listed first, and tools that say they may modify data carry a warning. The choice is saved per server in this browser and sent only with 2026-07-28 runs. In the CLI, `protocol conformance` accepts `--log-probe` and `--input-required-probe`, and `--fixtures-file` accepts `logProbe` and `inputRequiredProbe`. `protocol conformance-suite` now validates both on each run.

The Directory Readiness sections (Claude, OpenAI, Muse) are hidden from the Conformance page again behind the `mcpjam-directory-readiness` flag while directory submissions wait for a later phase.
