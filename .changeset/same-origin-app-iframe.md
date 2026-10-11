---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Clients can now say whether the MCP App iframe shares the sandbox page's origin (`mcpProfile.apps.sandbox.sameOriginAppIframe`). When it is `false`, the App mounts with `srcdoc` and no `allow-same-origin`, so it runs in an opaque origin where storage throws and fetches send `Origin: null` (what Claude's sandbox page does without its `stable-origin` flag). Apps that declare `ui.domain` keep a stable origin. Claude, Claude Desktop and ChatGPT are measured as same-origin (`true`). The setting is a toggle in the Clients tab and a "Same-origin app iframe" row on caniuse.
