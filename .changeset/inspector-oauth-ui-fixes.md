---
"@mcpjam/inspector": patch
---

OAuth and eval polish:

- Stop reconnect from wiping a server's saved OAuth config.
- Show the full saved OAuth config (clientId, scopes, secret flag, issuer) in the
  Configure modal, and cleaner client-secret reveal UX.
- Drop the blue focus ring on flow steps and add an issuer auto-discovery hint;
  render the IdP header in a flat container; keep ID-JAG lint rows inside the
  flow panel on narrow widths.
- Clearer welcome-screen instructions for newcomers.
- Configurable eval Generate (case count, per-bucket mix, vary user styles) plus
  assorted eval nits.
