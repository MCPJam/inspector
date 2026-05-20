# Hosted Deployment Notes

Configuration notes for operators self-hosting MCPJam Inspector. Not relevant
when running locally via `npx @mcpjam/inspector`.

## Sandbox origin (required for production)

The MCP Apps / ChatGPT Apps widget sandbox **must** be served from an origin
distinct from the host app. Without origin separation, widget code running
inside the sandbox iframe shares cookies and `localStorage` with the host app
even though the iframe carries `sandbox="... allow-same-origin"`. CSP is not a
substitute — origin separation is what enforces isolation.

### Configuration

Set at client build time:

```bash
VITE_MCPJAM_SANDBOX_ORIGIN=https://sandbox.example.com
```

`VITE_MCPJAM_SANDBOX_ORIGIN` must be:

- A different registrable origin from the host app (e.g. host on
  `app.example.com`, sandbox on `sandbox.example.com`), so the browser scopes
  cookies and storage separately.
- Reachable by browsers. The same MCPJam backend can serve both DNS names —
  no separate deploy is required. The sandbox host only needs to answer the
  two `GET` routes:
  - `/api/web/apps/mcp-apps/sandbox-proxy`
  - `/api/web/apps/chatgpt-apps/sandbox-proxy`

### DNS / routing

Point the sandbox hostname at the same backend that serves the host app.
There is no shared state between the host app and the sandbox proxy — the
proxy is a static bootstrap document that receives widget HTML via
`postMessage`.

### CSP

The sandbox proxy already emits a `frame-ancestors` directive that includes
every `https://` entry from `CORS_ORIGINS`. Make sure the host app origin
(e.g. `https://app.example.com`) is in `CORS_ORIGINS` so the host page is
allowed to frame the sandbox.

### Fallback behavior

If `VITE_MCPJAM_SANDBOX_ORIGIN` is unset in a hosted build, the iframe falls
back to same-origin and the client logs a security warning to the browser
console. The fallback exists only as a soft-fail for misconfigured deploys;
production deployments must set the variable. The regression test at
`client/src/components/ui/__tests__/sandboxed-iframe.hosted.test.tsx` pins
this contract.

### Local development

Local development is unaffected. The dev client swaps between `localhost`
and `127.0.0.1` to get origin separation without operator configuration.
