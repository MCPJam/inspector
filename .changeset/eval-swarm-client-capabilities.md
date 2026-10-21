---
"@mcpjam/inspector": patch
---

Eval and swarm browser sessions now advertise and enforce the saved client's MCP Apps capabilities instead of the harness defaults, and relay an MCP App's `resources/read` through the server connection that rendered it.

The client's host style preset applies in full, plus its overrides, so existing suites can change results. For example, a Cursor-style suite whose widget sends `ui/message` no longer gets the follow-up turn, VS Code-style clients refuse `ui/message`, Goose-style clients refuse server tool calls and resource reads, and ChatGPT-, Mistral- and Codex-style clients don't offer file downloads. A legacy `hostCapabilitiesOverride: {}` now advertises nothing.
