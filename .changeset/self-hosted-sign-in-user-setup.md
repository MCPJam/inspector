---
"@mcpjam/inspector": patch
---

Self-hosted Inspectors finish setting up a signed-in user without first waiting on the guest-session lookup when no guest was ever used in the browser. A load that stalls with no resolved actor now reports `app_load/actor_pending` instead of `app_load/user_setup_pending`.
