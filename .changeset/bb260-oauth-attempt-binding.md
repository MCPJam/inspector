---
"@mcpjam/inspector": patch
---

Keep sign-in attempts scoped to their project, server, surface and call. Verify saved calls before permitted redirects, retain prior scopes, and require the matching flow to settle an attempt.

Every `insufficient_scope` challenge now starts a step-up, including a bare `Bearer error="insufficient_scope"`, one with only an `error_description`, and one whose scope is blank. Those re-authorize with the previously requested scopes plus the server's advertised `scopes_supported`, still within the one-attempt budget.
