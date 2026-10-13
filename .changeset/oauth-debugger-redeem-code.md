---
"@mcpjam/inspector": patch
---

The OAuth Debugger now exchanges the authorization code for tokens as soon as sign-in returns it, instead of waiting for a Continue click at each step. Authorization servers expire codes quickly (Keycloak after 60 seconds), so stopping to read the prepared token request ended in `invalid_grant`. The token request and response stay in the HTTP history.
