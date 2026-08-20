---
"@mcpjam/inspector": patch
---

Add the `/login` initiate-login route so IdP-initiated SSO completes instead of failing the code exchange.

Clicking the MCPJam tile in an Okta dashboard got as far as WorkOS and no
further. Okta posts its SAML assertion, WorkOS validates it and sends an
authorization code to `/callback`, and `@workos-inc/authkit-js` refuses to
exchange it: "Couldn't exchange code… The developer may not have configured a
Login Initiation endpoint." Nothing was misconfigured on the SAML side. The
exchange runs client-side and needs the PKCE code verifier that sign-in wrote
into that tab's `sessionStorage` — a key that exists only when the sign-in
started in the app. A login that started at the identity provider has no such
tab, so the flow was unfinishable by construction, and enterprise SSO users had
no working entry point from their own dashboard.

The fix WorkOS sanctions is an Initiate Login URL. Once one is configured,
AuthKit recognizes a non-app-originated login and redirects the browser there
INSTEAD of issuing a code; the app then begins an ordinary sign-in, which
AuthKit completes silently against the SSO session the IdP already established
— no second prompt — and the code lands on `/callback` beside a verifier that
matches it.

`/login` is that URL. It has to be a client route rather than a server
redirect for exactly the reason the flow was failing: a server-generated PKCE
verifier cannot be written into the browser's `sessionStorage`. The SPA boots,
the route calls `signIn()`, and authkit-js mints its own. Both entrypoints
already serve `index.html` for unmatched paths, so no server change is
involved. An already-signed-in visitor (a second tile click) is sent into the
app rather than back through WorkOS.

Query parameters are ignored on purpose. The `context` hand-off the older
examples forward is deprecated — the endpoint is expected only to start a fresh
sign-in — and forwarding it could not work anyway, since authkit-js omits
`context` when it builds the authorize URL.

Taking effect also requires setting the Initiate Login URL to
`https://app.mcpjam.com/login` in the WorkOS dashboard (Applications →
Redirects, per environment), which is a dashboard setting rather than a code
change. Normal sign-in and guest mode are untouched: the route is additive.
