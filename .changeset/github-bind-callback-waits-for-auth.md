---
"@mcpjam/inspector": patch
---

Wait for authentication before finishing a GitHub App installation bind. GitHub's redirect is a full page load, so the Convex client had not attached a token when the callback fired its `signedInAction` — every bind failed with a bare "Server Error" and left the one-time state unconsumed.
