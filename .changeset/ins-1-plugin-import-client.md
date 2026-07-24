---
"@mcpjam/inspector": patch
---

Plugin import client foundations (INS-1): the JSON server-import parser now
accepts the OpenAI `mcp_servers` wrapper and a direct server map in addition to
the existing `mcpServers` wrapper (all three import identically), sharing the
three-shape unwrap contract with `@mcpjam/sdk/plugin-bundle`. Adds a typed
plugin-import client and upload helpers over the backend import endpoints, a
zero-dependency folder-to-ZIP helper for local/Electron mode (folder and ZIP
sources produce the same content-addressed bundle hash), and reactive import
progress hooks. No user-facing plugin UI yet.
