---
"@mcpjam/inspector": patch
"@mcpjam/cli": patch
"@mcpjam/sdk": patch
---

Release @mcpjam/inspector, @mcpjam/cli, and @mcpjam/sdk.

Cuts a version for the work that landed without a changeset of its own:

- **Member-only surfaces gate on the Convex actor, not the WorkOS user object.** A signed-in user is served a guest bearer in their HTML too, so for one render WorkOS says member while the socket still carries `guest|<uuid>`. Three surfaces asked member-only Convex functions in that window; they now check who the socket is actually authenticated as.
- **A swarm shows its own name as its Overview title.** `swarmWaveTitle` hardcoded `Swarm <short id>`, so the name typed in the create flow was invisible after setup. It now prefers the authored name and keeps the short id as the fallback, in both the Overview list and the Swarm Run detail page.
