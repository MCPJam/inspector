---
"@mcpjam/inspector": patch
---

Inspector rollup since the last release:

- Public API v1: new Inspector Node `/api/v1` routes for live-MCP servers/tools/resources/prompts, with a production fix to mount `/api/v1` in the production server entry.
- Evals: persist browser-rendered MCP App observations and steps in eval traces.
- Evals: cap eval iterations against the org's billing entitlement and surface a billing-limit-reached signal end-to-end.
- Billing: grace period for past-due/canceled orgs before access is gated.
- Billing: limit users to 1 self-created organization.
- Billing: rework the compare-plans table around credits and eval iterations; remove the team seat-minimum label and finish the Projects row.
- Sidebar credit usage: clicking the progress bar now sends the user to billing.
- Chatbox OAuth: attach the WorkOS bearer token on `/oauth/callback` to fix the 403 some users hit when finishing the chatbox auth flow.
- OAuth: send `client_secret` on token exchange with static preregistered credentials.
- Chatbox builder: removed the unused `allowGuestAccess` toggle.
