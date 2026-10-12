---
"@mcpjam/sdk": patch
---

Host templates now match how real clients treat `esm.sh` when an MCP App loads from it without declaring it. Claude and Claude Desktop no longer allow it, because real Claude blocks those loads. ChatGPT and Codex now allow it by default, because real ChatGPT and Codex load it. Clients already set up keep their old list until the user clicks "Update to latest".
