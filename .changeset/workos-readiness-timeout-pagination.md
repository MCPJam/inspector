---
"@mcpjam/inspector": patch
---

Fixed the API key readiness check hanging past its configured timeout when WorkOS sent response headers but stalled the body — the abort signal now stays armed through body consumption, not just until `fetch()` resolves. Also fixed `/api/web/api-keys` returning only the first page of a user's WorkOS API keys; it now walks `list_metadata.after` across pages instead of silently dropping keys past page one.
