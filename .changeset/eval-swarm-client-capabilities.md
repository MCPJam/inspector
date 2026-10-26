---
"@mcpjam/inspector": patch
---

Eval and swarm browser sessions now advertise and enforce the same MCP Apps capabilities chat does for the saved client, instead of the harness defaults, and relay an MCP App's `resources/read` through the server connection that rendered it.

The client's host style preset applies in full, plus its overrides, so existing suites can change results. For example, a Cursor-style suite whose widget sends `ui/message` no longer gets the follow-up turn, VS Code-style clients refuse `ui/message`, Goose-style clients refuse server tool calls and resource reads, Copilot- and Codex-style clients refuse resource reads, and ChatGPT- and Mistral-style clients don't offer file downloads. A legacy `hostCapabilitiesOverride: {}` now advertises nothing.

A saved client profile the run can't read now fails its eval case with "Invalid client profile at …" instead of leaving the run's rows pending.

Malformed direct resource-read requests return an error without exposing the server stack or reaching the MCP connection.
