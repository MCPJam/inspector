---
"@mcpjam/inspector": patch
---

Require a WorkOS user, not just Convex auth, before finishing a GitHub App installation bind. Guests are authenticated to Convex by design, so the previous gate let a guest call the member-only action and made the sign-in message unreachable.
