---
"@mcpjam/inspector": patch
---

Feature flags work again in the local Inspector. Since posthog-node 5.73.0 asks for flags on a new endpoint version, local installs had every server-evaluated flag off or missing, including ones targeted to your account.
