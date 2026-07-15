---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Unify the OAuth resource-indicator policy: one shared evaluator, per-surface enforcement.

- New `evaluateResourceIndicator` (`sdk/src/oauth/resource-policy.ts`, exported from `@mcpjam/sdk/browser`) resolves the RFC 8707 `resource` once — precedence PRM → authorization-URL → configured → server URL — returning `{value, source, status, strictClientCompatible, reason}`. Same-origin is the validity/security boundary; the official MCP SDK's path-prefix binding is reported separately as `strictClientCompatible` so real servers (e.g. Asana's `/sse` transport with a `/v2/mcp` PRM resource) stay connectable.
- The debug state machines resolve the decision once at PRM discovery, persist it as `OAuthFlowState.resourceIndicator`, and every request and sequence-diagram preview site reads that value. A new `resourceIndicatorEnforcement: "warn" | "reject"` machine config makes enforcement per-surface: the debugger warns and continues; `mcpjam oauth login` and the conformance runner fail the discovery step on invalid/cross-origin PRM metadata.
- client_credentials grants (oauth-login, conformance runner) and the negative-check baselines now honor the PRM-advertised resource instead of always sending the canonical server URL.
- The inspector's Quick OAuth resolves through the same evaluator (its private canonicalizer/validator/precedence copy is deleted); rejection messages now name the offending source and reason.
- `ResolvedAuthorizationPlan` gains an optional `resourceIndicator` decision when discovery metadata is available; `canonicalResource` semantics are unchanged.
