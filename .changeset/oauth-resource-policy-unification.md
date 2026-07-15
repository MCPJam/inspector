---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Unify the OAuth resource-indicator policy: one shared evaluator, per-surface enforcement.

- New `evaluateResourceIndicator` (`sdk/src/oauth/resource-policy.ts`, exported from `@mcpjam/sdk/browser`) resolves the RFC 8707 `resource` once — precedence PRM → authorization-URL → configured → server URL — returning `{value, source, status, strictClientCompatible, rfc9728Compliant, reason}`. Same-origin is the usability/security boundary; RFC 9728 compliance and the official MCP SDK's path-prefix binding are reported separately so real servers (e.g. Asana's `/sse` transport with a `/v2/mcp` PRM resource) stay connectable without being mislabeled as conformant.
- The debug state machines resolve the decision once at PRM discovery, persist it as `OAuthFlowState.resourceIndicator`, and every request and sequence-diagram preview site reads that value. A new `resourceIndicatorEnforcement: "warn" | "reject" | "reject-rfc9728"` machine config makes enforcement per-surface: the debugger warns and continues; `mcpjam oauth login` rejects invalid/cross-origin metadata while retaining interoperability; the conformance runner additionally rejects RFC 9728-noncompliant metadata.
- client_credentials grants (oauth-login, conformance runner) and the negative-check baselines now honor the PRM-advertised resource instead of always sending the canonical server URL.
- The inspector's Quick OAuth resolves through the same evaluator (its private canonicalizer/validator/precedence copy is deleted); rejection messages now name the offending source and reason.
- Advertised resource strings remain verbatim through strict SDK `auth()`, Quick OAuth callback exchange, storage, and refresh; the public `selectResourceURL()` helper keeps its existing `URL` return contract.
- `ResolvedAuthorizationPlan` gains an optional `resourceIndicator` decision when discovery metadata is available; `canonicalResource` semantics are unchanged.
