---
"@mcpjam/chat-ui": minor
---

Derive the package's default scoped theme from the canonical MCPJam design tokens.

The `.mcpjam-chat-ui` fallback tokens were hand-maintained stock shadcn neutrals, so
a host that had not defined its own tokens rendered the transcript in grey-blue zinc
rather than MCPJam's warm paper and ink. Those values are now generated from
`design-system/src/tokens.css` and checked in CI.

This only affects embedders relying on the package defaults; hosts that define their
own tokens (including the MCPJam inspector itself) are unchanged. To keep the
previous look, override the `--token` values on `.mcpjam-chat-ui`.
