---
"@mcpjam/inspector": patch
---

Stop the MCP connection OAuth handler from hijacking other routes' callbacks.

The effect that completes an MCP server's OAuth flow ran on every route and treated any URL carrying `?code=` as its own. Its only exclusion was the OAuth debugger path, so the GitHub App installation bind — which returns to `/settings/integrations/github/callback` — was claimed by it too: the handler tried to complete an MCP flow that did not exist, failed with "No pending OAuth flow found", raised that toast, and then navigated away, stripping GitHub's `code` and `state` out of the URL before the route that owned them could read them. The bind page then reported "opened without the details GitHub sends", which is true and completely misleading about the cause. Connecting a GitHub account failed every time in production.

The handler now declines a callback when no MCP OAuth flow is pending. That fact is derived rather than declared: both completion paths read the same pending marker and throw "No pending OAuth flow found" when it is absent, so with no marker there was never an MCP flow to complete and claiming the callback could only ever have failed. A path exclusion list was deliberately not used — it would need a new entry for every future OAuth-shaped route and would silently break whichever one nobody remembered to add.

One deliberate consequence: a genuinely orphaned MCP callback, where the pending marker was lost to cleared storage or another tab, no longer raises an error toast. It was unrecoverable either way, and the message named nothing the user could act on.
