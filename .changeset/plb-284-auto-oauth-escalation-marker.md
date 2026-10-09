---
"@mcpjam/inspector": patch
---

Fix Auto OAuth escalation after a redirect: the pending marker now survives the round trip and is cleared when the callback finishes, so a denied authorization no longer makes the next attempt fail with "still returns 401 after OAuth". First-run onboarding no longer shows "could not verify the server" when a newer connection attempt takes over.
