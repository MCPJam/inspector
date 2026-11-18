---
"@mcpjam/inspector": patch
---

Organization settings has a new Security section with an Allow credential export switch. Organization owners and admins can turn it off to stop saved OAuth tokens, API keys and secrets from being sent to members' local apps, the CLI and sandboxes, or revealed in the browser; other members see it read-only. Tokens already delivered keep working until they expire. Refusals under the policy now say where the switch is.
