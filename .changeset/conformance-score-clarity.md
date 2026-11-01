---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Conformance: a failed or incomplete run now scores the share of applicable checks that passed (capped at 94), so the percentage matches the fraction beside it. Runs where every applicable check passed score as before. The Conformance page lists passed, failed, could-not-run, unscored and not-applicable counts separately, and marks a score with unrun checks "partial". When checks were refused for sign-in, it reads "Incomplete. N checks could not run because sign-in failed." instead of "Not conformant".
