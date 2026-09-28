---
"@mcpjam/inspector": patch
---

The New swarm confirm step now prices the exact launch before it runs, and offers a smaller plan when the organization's credits cannot fit it.

- **Quote under the total.** Confirm quotes the concrete plan: one run per new goal at its persona's iterations, plus the reused goals at this run's iterations and environments. It re-quotes on every change and shows "M free starter conversations · about N credits" under the conversation total.
- **When the plan doesn't fit,** Launch is held back and Confirm says "You don't have enough credits to complete this run." **Run K conversations instead** builds a smaller plan that keeps a goal from each persona first, then iterations, then reused personas. It quotes that exact plan and applies it only if that quote fits.
- **A quote that fails** shows "Couldn't estimate credits" and does not block the launch. Launch admission decides either way.
- **Launching.** A launch refused for credits partway through a wave now says the rest need credits. A launch whose admission was too busy to decide (503) is retried up to three times with the same launch key.
- **Starter allowance copy.** The sidebar and the usage card now say "Free starter iterations", and explain that swarm conversations on standard models draw from the same allowance without using daily credits.
- **Analytics.** `swarm_create_launched` gains `estimated_credits`, `starter_sessions` and `fits`. New events: `swarm_create_credit_blocked` and `swarm_create_fit_applied`.
