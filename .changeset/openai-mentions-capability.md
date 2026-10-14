---
"@mcpjam/inspector": patch
---

Composer @-mentions find a server's search tool through the `openai/mentions` capability (the tool must be read-only and visible to Apps), falling back to the deprecated per-tool declaration only when the capability is absent. An unusable declaration now explains itself in Logs instead of breaking mention search.
