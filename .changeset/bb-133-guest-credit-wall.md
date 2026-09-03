---
"@mcpjam/inspector": patch
---

Add a benefit-led A/B variant of the guest credit-limit modal (BB-133). Behind the PostHog flag `guest-credit-wall-copy`, the treatment replaces the single "Sign in" wall with a headline, value copy, a hero illustration, and two CTAs — "Create free account" (sign-up) and "See paid plans" (pricing page). The `plan_limit_*` events now carry a `variant` tag so sign-in vs create-account conversion can be compared across control and treatment. Defaults to the existing control modal when the flag is off.
