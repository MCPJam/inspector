---
"@mcpjam/inspector": patch
---

Serve WorkOS client config at runtime instead of baking it into the bundle, and delete the dead `VITE_WORKOS_DEV_MODE` knob.

`VITE_WORKOS_CLIENT_ID` and `VITE_WORKOS_API_HOSTNAME` were inlined by Vite at build time, which meant every environment needed the value listed in two hand-maintained places that nobody diffs: the Railway service variables, and the `ARG` allowlist in `mcpjam-inspector/Dockerfile`. Miss either one and the client does not fail to build — it ships silently misconfigured.

That is what happened to staging. It carried no `VITE_WORKOS_API_HOSTNAME`, so `resolveWorkosClientOptions` fell through to the default `api.workos.com`. From `staging.mcpjam.com` that host is cross-site, so the AuthKit session cookie was never sent; `#refreshSession` posted `{client_id, grant_type: "refresh_token"}` with no credential, got a 400, and `#doRefresh`'s catch called `removeSessionData()`. Because AuthKit stores the refresh token in `memoryStorage` outside dev mode, nothing survived the page load and every single navigation logged the user out. Production was unaffected only because it sets the variable to `auth.mcpjam.com`, which shares a registrable domain with `app.mcpjam.com`.

The downstream symptoms all traced back to that one 400: the hosted shell showed its `logged-out` gate (staging runs `NON_PROD_LOCKDOWN`, so there is no guest fallback to absorb it), `AppReadyProvider` never left `resolving-auth`, and MCP server OAuth appeared to fail — tokens are persisted through `/api/web/oauth/import-tokens`, which forwards the caller's bearer, so with no session the credential could not be written and the next connect attempt replayed the consent screen.

Both values now ride the existing `window.__MCP_RUNTIME_CONFIG__` channel that already carries the Convex URLs (`getInspectorClientRuntimeConfig` in `server/env.ts`, read by `client/src/lib/runtime-config.ts`). The serving process knows which WorkOS environment it belongs to; the bundle no longer has to. A Railway variable change now takes effect on restart, in every environment, with no rebuild and no Dockerfile edit.

This is backward compatible and needs no deploy-config change: the server reads the canonical unprefixed `WORKOS_CLIENT_ID` / `WORKOS_API_HOSTNAME` first and falls back to the `VITE_`-prefixed names, which Railway already injects into the running container. The client still falls back to its build-time value when no runtime config is present, so npx and Electron builds are unchanged. The Dockerfile `ARG`s are deliberately left in place for now — removing them is a separate cleanup once every environment has been confirmed on the runtime path.

Two smaller fixes ride along:

- **`getInspectorClientRuntimeConfigScript` keyed its "inject anything at all?" guard off the two Convex fields.** An environment with WorkOS config but no Convex URL would have emitted no script and silently fallen back to build-time values. It now checks every field.
- **`resolveWorkosDevMode` is gone.** It read `VITE_WORKOS_DEV_MODE`, which was set in no environment and was absent from the Dockerfile `ARG` allowlist, so no deployed build could set it — a config knob that could not be configured. It was added in the same change as the first-party AuthKit proxy at `/user_management`, which is what actually gives local dev cookie mode, and it existed only to opt out of the mode that proxy made universal. It is replaced by an exported `WORKOS_DEV_MODE = false` constant, still passed explicitly to `AuthKitProvider`, because `@workos-inc/authkit-js` defaults `devMode` to `location.hostname === "localhost"` — omitting the prop would move local dev onto a different session-storage path than every deployed environment.
