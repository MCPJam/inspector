---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
"@mcpjam/widget-react": patch
---

Clients can now say whether the MCP App iframe shares the sandbox page's origin (`mcpProfile.apps.sandbox.sameOriginAppIframe`). When it is `false`, every App mounts with `srcdoc` and no `allow-same-origin`, so it runs in an opaque origin where storage throws and fetches send `Origin: null`. Claude, Claude Desktop, ChatGPT and Codex are measured as same-origin (`true`). Copilot is measured as not same-origin (`false`), so Apps in MCPJam's Copilot client now see storage throw and `Origin: null`, like they do in real Copilot. The setting is a toggle in the Clients tab and a "Same-origin app iframe" yes/no row on caniuse.
