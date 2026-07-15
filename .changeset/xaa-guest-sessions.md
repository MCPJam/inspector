---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Let guest (not-signed-in) sessions run the full XAA / ID-JAG flow.

- Add a visibly separate anonymous test issuer (`/g/<personalOrgId>`) whose discovery document is marked `mcpjam:issuer_kind: anonymous-test`, so a RAS must explicitly allowlist it; the membership-gated `/o/<orgId>` issuer stays signed-in-only.
- Derive the issuer kind from the session (signed-in → `org`, guest → `anonymous`) and thread it through discovery, the SDK mint request, hosted forwards, and the negative-test scorecard.
- Forward the end-user client IP to the backend only alongside a valid `INSPECTOR_SERVICE_TOKEN` so the per-IP guest quota can't be spoofed; warn once when the token is unset.
- Label the anonymous issuer in the IdP card, noting it is a testing convenience — not enterprise-managed-authorization conformance.
