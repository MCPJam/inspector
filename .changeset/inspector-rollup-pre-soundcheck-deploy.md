---
"@mcpjam/inspector": patch
---

Inspector rollup since the last release:

- Chatbox OAuth: attach the WorkOS bearer token on `/oauth/callback` to fix the 403 some users hit when finishing the chatbox auth flow.
- Sidebar credit usage: clicking the progress bar now sends the user to billing.
- Compare-plans table: removed the team seat-minimum label and finished the Projects row in the plan comparison.
- Chatbox builder: removed the unused `allowGuestAccess` toggle.
