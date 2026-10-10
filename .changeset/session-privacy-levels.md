---
"@mcpjam/inspector": patch
---

Session replay now runs at a privacy level: `full`, `masked` or `off`. The packaged desktop app and organizations with enterprise privacy are recorded masked: text, inputs and media are hidden, console logs and network detail are left out, and names are removed from recorded URLs. Members of such organizations are identified by id only. Hosted replay now starts once the session's level is known, and an unknown level falls back to masked. npx and Docker installs still record nothing. The MCP UI tool action payload is no longer logged outside dev builds.
