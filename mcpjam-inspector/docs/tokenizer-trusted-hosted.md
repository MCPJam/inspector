# Hosted tokenizer authentication

All three backend tokenizer callers use `server/utils/tokenizer-backend.ts`.
The destination comes only from server `CONVEX_HTTP_URL` and must be an origin.
The transport reuses `getConfiguredInspectorServiceToken()` and attaches the
service header only for hosted Node servers over HTTPS. Electron is explicitly
excluded even when its environment has hosted mode and a token. Redirects fail
closed and existing callers fall back to character estimates without retrying.

Do not use `guestIpForwardHeaders()` here: that helper requires a client IP hash;
the trusted tokenizer lane only needs service authentication.

## User-story checklist (independent development tester)

- [x] Hosted tool counting attaches the existing server credential.
- [x] All three fetch sites share the credential/destination boundary.
- [x] Local, self-hosted, tokenless hosted, and Electron callers remain anonymous.
- [x] Incoming URL/auth headers cannot select a recipient or supply trust.
- [x] 429, backend 503, connection failure, and redirect preserve the estimate
  with one attempt per count (one per server for the legacy fan-out route).
- [x] Minimal helper bundle built with a dummy canary contains no credential
  value; the token lookup stays at runtime. Packaged `.env.production` has no
  service-token assignment.
- [ ] Full browser/Electron artifact validation and required CI checks pass.
- [ ] Actual staging and production hosted traffic consumes the backend's
  `tokenizerCountTrusted` / `inspector` bucket before reducing anonymous limits.
- [ ] Representative local/self-hosted traffic validates the proposed 30/min/IP.

Focused development verification: 63 tests passed across the helper's existing
suite and the two new suites, including a real localhost redirect/no-retry test.
These are agent-run development checks, not production or human QA sign-off.

## Deployment and rollback

Deploy this change first, leaving the backend anonymous rate at 600. Use the
existing environment-matched `INSPECTOR_SERVICE_TOKEN` in the hosted runtime
secret store. Never put its value in `VITE_*`, `.env.production` (copied into
Electron packages), Docker build arguments, client configuration, logs, or
telemetry. No new secret or change to browser/desktop build configuration is
required. The hosted destination is operator-controlled configuration.

Verify a real hosted tool-list request consumes the trusted backend bucket; a
successful response or a configured token alone is insufficient evidence.
Record deployed SHAs, timestamps, lane counts, 429s, latency, and fallback
frequency without retaining IPs, headers, tool content, or credentials.

The backend draft reduces anonymous burst/refill to 30/min/IP. Hold it until
hosted verification and local/self-hosted threshold checks pass. Legacy
count-tools fans out per server, and shared egress pools callers; 30 requests
is not 30 user actions. Hosted legacy `/api/mcp/tokenizer/*` is disabled;
hosted counting comes from authenticated web routes via `countToolsTokens`.

If the lower allowance causes trouble, restore the backend's previous 600
allowance while keeping this authentication change. To roll back this
Inspector change itself, restore the backend allowance first, then revert the
Inspector commit through the normal release workflow.

The coordinated backend runbook is `docs/tokenizer-abuse-rollout.md` in
`MCPJam/mcpjam-backend`. Both PRs remain draft until rollout gates are resolved.
