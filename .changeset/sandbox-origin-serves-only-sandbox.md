---
"@mcpjam/inspector": patch
"@mcpjam/widget-react": patch
---

The sandbox hostname now serves only the sandbox.

`sandbox.mcpjam.com` is a second DNS name on the same service, and the server
answered every hostname identically — so the origin whose entire job is holding
untrusted widget content also served the app shell, its bundle, and `/api`.
`HOSTED_DEPLOYMENT.md` said the sandbox host "only needs to answer" the proxy
route; nothing enforced it. A host listed in the new `SANDBOX_HOSTS` (default
`sandbox.mcpjam.com,sandbox-staging.mcpjam.com`) now answers
`/api/web/apps/mcp-apps/sandbox-proxy` and `/health`, and 404s everything else.
`SANDBOX_HOSTS=""` turns the partition off.

It also fixes the alert that surfaced this. The client's boot guard treated
`VITE_MCPJAM_SANDBOX_ORIGIN === window.location.origin` as a misconfigured
deploy, and a crawler walking our DNS names tripped it by loading the Inspector
on the sandbox hostname, where that equality holds by definition. No page can
tell that apart from an app deploy pointing its sandbox at itself: the browser
does not know which hostname it was supposed to be served as. That half of the
invariant moved to the server, which does — it logs once at boot and reports
`sandboxIsolation` on `/health`. The client guard keeps only the case a browser
can decide, hosted mode with no origin configured at all, and now lives in
`client/src/lib/sandbox-origin-fault.ts` where it is testable.

`SandboxedIframe` had been walking straight through the condition the guard
flagged: a `sandboxOrigin` equal to the app's own origin produced a same-origin
"sandbox" with no warning. It now treats that as unset and takes the existing
warn-and-fall-back path, comparing canonical origins so a trailing slash, a
different case, or an explicit `:443` cannot spell past the check. The URL logic
is extracted as `resolveSandboxProxyUrl`, newly exported from
`@mcpjam/widget-react`.

`SANDBOX_HOSTS` entries are validated as bare hostnames. One carrying a scheme,
a port, or a path can never match the `Host` the partition reads, so it is
dropped rather than left to report an isolation nobody checked.

Cookies were never at risk — they are set without a `Domain=` attribute, so
`app.mcpjam.com` credentials never reached the sandbox host.
