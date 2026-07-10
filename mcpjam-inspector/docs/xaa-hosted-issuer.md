# Testing XAA with a local MCP server and a cloud authorization server — no tunnel

The most common Cross-App Access (XAA) dev setup is:

- your **MCP server** running on `localhost`,
- your **authorization server** running in the cloud (Scalekit, Okta, Auth0, …),
- MCPJam running locally as the debugger.

Out of the box this breaks at issuer discovery: a local MCPJam run advertises an
issuer like `http://127.0.0.1:6274/api/mcp/xaa`, and a cloud authorization
server validating the ID-JAG can't fetch that issuer's discovery document or
JWKS. Historically the workaround was moving everything to
`app.mcpjam.com` and exposing your MCP server with ngrok.

The **"Use hosted issuer"** toggle (XAA tab → identity-provider bar) removes
the tunnel entirely. Only the *minting* of the mock ID token and ID-JAG needs a
publicly reachable issuer — so with the toggle on, your local MCPJam forwards
just those mint calls, server-to-server, to `app.mcpjam.com` using your
signed-in session. Everything else stays on your machine:

| Step | Where it runs |
| --- | --- |
| Mock SSO + ID-JAG mint | `app.mcpjam.com` (forwarded, signed by the hosted key) |
| ID-JAG → access token at *your* AS | your machine → your cloud AS |
| MCP request with the access token | your machine → `localhost` MCP server |

## Setup

1. Sign in to MCPJam locally (the toggle is disabled for guests — a local
   guest session can't authenticate to the hosted issuer).
2. In the XAA tab, flip **Use hosted issuer (app.mcpjam.com)**. The issuer /
   OpenID config / JWKS chips switch to your **organization-scoped** hosted
   issuer:

   ```
   https://app.mcpjam.com/api/web/xaa/o/<your-org-id>
   ```

3. In your authorization server, trust that issuer for ID-JAGs (issuer URL or
   JWKS URL — both resolve to the same keys) and register the client ID the
   debugger presents.
4. Run the flow. The decoded ID-JAG's `iss` is the hosted issuer; the token
   request and the final MCP call originate from your machine.

## Why the issuer is organization-scoped

Minting under `…/xaa/o/<orgId>` requires being a signed-in member of that
organization, so an authorization server that trusts your scoped issuer can
only receive assertions minted by your org's members. The legacy unscoped
issuer (`https://app.mcpjam.com/api/web/xaa`) is mintable by anyone with an
MCPJam session — treat it as throwaway/test-only and prefer the scoped issuer
whenever you register MCPJam in a real authorization server.

## Notes and limits

- **Negative tests** are forwarded too. They mint deliberately-broken
  assertions, and those must carry the same hosted `iss` as the positive run —
  otherwise every case would be rejected for issuer mismatch and the scorecard
  would "pass" without testing anything.
- Because forwarded runs execute the outbound token calls from the hosted
  service, your authorization server must be reachable over **https** for the
  negative-test scorecard. The positive flow's token request still runs
  locally, so a localhost AS keeps working with the toggle **off**.
- The hosted origin can be overridden for staging with the
  `MCPJAM_HOSTED_ORIGIN` env var on the local inspector server.
