---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Alias MCP tool names that Anthropic, Bedrock or OpenAI reject (such as `cart.add`) in the request a provider sees, and restore them in its reply. Direct BYOK chat and evals, hosted chat and evals, and `HostRunner` no longer fail every turn on a server with dotted or slashed tool names. Claude Code harness turns on Anthropic or Bedrock models still reject them up front.
