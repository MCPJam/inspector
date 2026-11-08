---
"@mcpjam/inspector": patch
---

Scheduled eval runs, GitHub PR checks and Connector Bench runs now connect to servers that use Cross-App Access instead of failing with "Missing XAA issuer". They mint under the issuer an interactive run uses, built from `MCPJAM_INSPECTOR_PUBLIC_URL`. Scheduled runs also apply their host's enterprise-managed authorization policy, as an API launch of the same suite does.
