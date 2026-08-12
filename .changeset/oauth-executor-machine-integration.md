---
"@mcpjam/inspector": patch
---

Cover the executor ↔ state-machine seam with a real integration test, and gate the MCP OAuth wire invariants on named assertions.

Every OAuth test mocked one side of the joint the #3865 bug lived in: the inspector's tests mock `@mcpjam/sdk/browser`, and the SDK's tests stub the request executor. Nobody wired the real pair, which is how a redactor applied to live response bodies reached production.

`client/src/lib/oauth/__tests__/oauth-refresh-integration.test.ts` mocks only what cannot exist in a unit process — `@/lib/config` pinned to the hosted configuration that exhibited the bug, and `authFetch` replaced by a forwarder that performs the same unwrap the real `/api/web/oauth` proxy does before making a real request. `@mcpjam/sdk/browser` is deliberately not mocked; `client/vitest.config.ts` already aliases it to SDK source, so the real state machines run. The whole flow — initiate, authorize, callback — takes about two seconds and needs no browser.

The oracle is the fixture rather than our own options object. `e2e/fixtures/fake-oauth-mcp-server.ts` returns 401 from `/mcp` unless `Authorization` matches byte-for-byte, so the happy-path test proves the token is usable rather than merely non-empty. The wire invariants are asserted by name against the requests the fixture actually received: same canonical `resource` on the authorization and token requests, S256 PKCE end to end, one `redirect_uri` reused across registration/authorization/exchange, no MCP bearer token on any OAuth endpoint, zero token requests when callback `state` is missing or mismatched, no raw nonce in the published trace, fail-closed on missing PKCE or protected-resource metadata, and no foreign configured `resourceUrl` reaching the wire.

Named assertions rather than snapshots alone: accepting an updated snapshot must not be able to make a missing `S256`, a broken resource binding, or a forwarded credential look normal.

The fixture gains an opt-in `tokenFailure` and metadata overrides, plus full URL, query, and headers on its request log. Defaults are byte-identical, so both Playwright projects are unaffected.
