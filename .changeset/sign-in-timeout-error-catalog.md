---
"@mcpjam/sdk": patch
---

The error catalog has two new entries, `auth/sign_in_timed_out` and `auth/sign_in_cancelled`, for a browser sign-in that ran out of time or was cancelled. `describeAsSlug` used to return the unknown-error entry for both.
