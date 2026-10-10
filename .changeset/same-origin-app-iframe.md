---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Clients can now say whether the MCP App iframe shares the sandbox page's origin (`mcpProfile.apps.sandbox.sameOriginAppIframe`). Claude and Claude Desktop set it to `false`, matching claude.ai: the App mounts with `srcdoc` and no `allow-same-origin`, so it runs in an opaque origin where storage throws and fetches send `Origin: null`. Apps that declare `ui.domain` keep a stable origin. The setting is a toggle in the Clients tab and a "Same-origin app iframe" row on caniuse.
