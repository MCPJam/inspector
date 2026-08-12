---
"@mcpjam/sdk": minor
---

Add `@mcpjam/sdk/oauth/node`, a Node-only entry point for SSRF-hardened OAuth networking.

The guard that keeps an outbound OAuth fetch from reaching private infrastructure is already written, tested, and complete — it just isn't reachable from a Node consumer that isn't the Inspector. Both existing doors are the wrong shape:

- The root `@mcpjam/sdk` entry exports the DNS-pinned proxy (`executeOAuthProxy`, `fetchOAuthMetadata`, `validateUrl`), but importing it pulls in the entire SDK graph — `ai`, every provider package, the eval runtime, the client manager. `dist/index.js` is 1.69 MB. A backend action that only wants to fetch an authorization-server metadata document safely should not have to load a model factory to do it.
- `@mcpjam/sdk/browser` exports the RFC 6890 classifier (`isPrivateHost`, `isDisallowedIpAddress`, `assertOutboundOAuthUrlAllowed`), and stops there deliberately. Classification alone does not close the DNS-rebinding window: a bare public hostname passes the classifier by design, on the understanding that the caller will resolve it, validate every answer, and pin the surviving addresses into the socket. That resolution step needs `node:dns` and has always lived on the Node side.

So a Node consumer outside this repo could have the cheap half or the complete half, never a cheap complete half. `@mcpjam/sdk/oauth/node` is that: the classifier and the pinned transport together, with `node:dns`, `node:http`, and `node:https` as the only imports in the whole graph. The built entry is 29.58 KB.

The immediate consumer is `mcpjam-backend`, whose hosted OAuth discovery, token exchange, and refresh paths still use unrestricted `fetch`. Those are the requests where an attacker-influenced URL — a hostile server's `resource_metadata` pointer, a redirect hop — is most worth steering at 169.254.169.254 or a LAN address, and they are the ones with a credential attached. Giving the backend an import instead of a port is the point: a second copy of an SSRF policy is a copy that drifts, and the drift is silent until it is a vulnerability.

Nothing else changes. This is additive — a new export map entry, a new tsup entry, and a file that contains only re-exports. Existing imports from the root entry and from `/browser` are untouched.

Two things are locked down by tests rather than convention. The re-exports are asserted by **identity** against `oauth-proxy.ts` and `oauth/ssrf-guard.ts`, so a future fork fails the suite instead of quietly diverging while still type-checking. And the import graph is walked transitively and asserted to reach only `node:` builtins, so the "safe for a backend action" property survives someone adding a heavy import three modules deep in `oauth-proxy.ts` — the check fires there, not in a backend deploy months later.
