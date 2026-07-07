# xaa-demo — a toy Cross-App Access (XAA) MCP server

A tiny MCP server that also plays its own authorization server, for the
[Debug a Cross-App Access failure](https://docs.mcpjam.com/guides/debug-xaa-cross-app-access)
how-to. It verifies MCPJam's signed pass (ID-JAG) for real, mints an access
token, and guards its MCP endpoint with an audience check.

It ships with a **deliberately wrong** `CANONICAL_URL` so the XAA Debugger's
flow fails at the last step with a 401 — the bug the guide teaches you to fix.

## Run

```bash
npm install
npm start
# xaa-demo listening on http://localhost:8080 (audience required: https://demo.example.com/mcp)
```

Then connect `http://localhost:8080/mcp` in MCPJam Inspector and open the XAA
Flow tab. See the guide for the full walkthrough.

## The fix

Set the audience to the address you actually reach the server at:

```bash
CANONICAL_URL=http://localhost:8080/mcp npm start
```

## Test

```bash
npm test
```

The suite proves the bug reproduces (401) and the fix works (200) without
needing the browser.

## How it works

| Endpoint | Role |
| --- | --- |
| `GET /.well-known/oauth-protected-resource` | Tells clients which authorization server guards this resource (itself). |
| `GET /.well-known/oauth-authorization-server` | Advertises the `jwt-bearer` grant + token endpoint. |
| `POST /token` | Verifies the ID-JAG against MCPJam's JWKS, mints an access token bound to the requested resource. |
| `POST /mcp` | The MCP endpoint. Requires a Bearer token whose `aud` matches `CANONICAL_URL`; otherwise returns 401. |

> This toy trusts the pass's own issuer for simplicity. A production server must
> pin the specific identity issuer it trusts (set `TRUSTED_ISSUER`).
