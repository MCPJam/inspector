---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

An exact client capability set (what a client preset sends) no longer advertises `sampling` or `roots`, because `MCPClientManager` answers neither `sampling/createMessage` nor `roots/list`. Before, a Goose, VS Code, Copilot CLI, Claude Code or Cursor preset told servers it could answer them, and a server that asked got `-32601`. The SDK exports the withheld keys as `UNANSWERED_CLIENT_CAPABILITIES`. Harness pass-through still admits a connection pinned to the CLI's own handshake, since on pass-through the CLI declares and answers them itself.
