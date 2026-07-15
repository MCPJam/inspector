---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
---

Auth "Auto": unauthenticated-first connection with OAuth escalation.

- New "Auto" auth method: connect with no credentials first, and only escalate to the OAuth flow when the server answers the initialize request with a 401 challenge. Servers that don't require auth connect immediately with zero configuration.
- Auto is now listed first in the auth-method dropdown and is the default for new servers; the dropdown gets short labels, per-option descriptions, and a per-server helper explaining what Auto will do. The escalation UI was simplified to a single inline prompt.
- **SDK:** new `isUnauthorized401` export for classifying the 401 challenge that triggers escalation.
