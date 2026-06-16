---
"@mcpjam/chat-ui": patch
---

`JsonView` and the markdown wrapper now wrap long content via Tailwind
utilities (`whitespace-pre-wrap` + `overflow-wrap`) instead of relying solely on
the package stylesheet's `.mcpjam-chat-json` / `.mcpjam-chat-markdown` rules. Tool
input/output and markdown no longer scroll horizontally when a consumer renders
the transcript with Tailwind but hasn't imported `@mcpjam/chat-ui/styles.css`.
