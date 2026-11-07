---
"@mcpjam/inspector": patch
---

Mid-session sign-in fixes:
- In hosted mode, a sign-in tied to one login on a server with two or more logins now reconnects the server, so the paused call runs again instead of failing with "Could not retry the call after sign-in."
- The Tools tab shows only the sign-in card for a sign-in request, not a misleading "Forbidden (403)" panel.
- A sign-in card that expires before the user signs in now says "This call expired. Sign in and run it again."
- A call closed while its server is disconnected no longer names the server "unknown".
