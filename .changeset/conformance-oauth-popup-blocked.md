---
"@mcpjam/inspector": patch
---

When the browser blocks the OAuth authorization popup on the Conformance page, the OAuth suite now says so and offers "Open authorization page" instead of waiting silently until the session expires. While it waits for authorization, you can also skip OAuth, which leaves it not scored rather than failed.
