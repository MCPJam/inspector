---
"@mcpjam/sdk": minor
---

Add the XAA enterprise-managed authorization policy helpers: `readXaaEnterprisePolicy` (three-state: off / on / invalid), `withXaaEnterprisePolicy`, `withoutXaaEnterprisePolicy`, and the `XAA_ENTERPRISE_POLICY_EXTENSION` / `XAA_ENTERPRISE_POLICY_IDPS` constants. The policy is stored under `hostConfig.mcpProfile.extensions["com.mcpjam/enterprise-managed-auth"]` and marks a host persona as enterprise-managed: every HTTP server connection resolves to XAA by default unless the server's explicit auth method overrides.
