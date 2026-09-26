# Desktop proxy diagnostics

These diagnostics add context to Electron native reports without changing connections, login, retries or UI. They do not establish that a proxy exit caused an OAuth error or that a successful connection means the proxy process recovered.

## Reading a report

Look at `contexts.desktop_diagnostics` on a native event:

- `run_id` / the `desktop_run_id` tag identify one app process, not a user or installation.
- `activity` contains up to 50 entries from the preceding two minutes: auth state, OAuth authorization/callback, token import, connect and reconnect, and renderer navigation/exit. Times are main-process epoch milliseconds. Operation IDs are random, not OAuth state or server IDs.
- `auth` uses WorkOS account state (loading, signed in, guest), not Convex authentication, which also accepts guests. The renderer sends a heartbeat every 15 seconds. `renderer_context_stale` means no update for 30 seconds or a renderer navigation/exit; stale auth is not proof of the current account state.
- Native Sentry context already contains the main app and Electron versions; `renderer_version` lets us spot mismatched bundles.
- `observation_event_id` identifies the follow-up event. Search its event ID in the same Sentry project, or filter by `desktop_run_id`. The follow-up lists matching native event IDs too. A native report may be uploaded too late to get a direct link; the run ID and time are the fallback.

`Desktop proxy process observation` is an informational event in `inspector-electron`, grouped under `desktop-proxy-observation`. It observes ordinary application activity for 60 seconds after an unexpected `proxy_resolver.mojom.ProxyResolverFactory` exit. Repeated exits in that window are combined; at most five follow-ups are sent per app run. The summary includes the prior activity, subsequent activity, exit count/reason/code, connection success/failure counts, renderer deaths, and both app versions.

Outcomes describe evidence only:

- `connection_succeeded_afterward`: at least one connection/reconnection succeeded; check failure counts too.
- `connections_failed_afterward`: failures were observed, with no later success in the window.
- `no_connection_observed`: no terminal connection result was observed. This is not proof of recovery or failure.

A normal app quit finishes observation as `interrupted`, without waiting for delivery. An abrupt termination or offline shutdown can leave no follow-up. Missing telemetry is unknown. Renderer navigation is recorded separately and does not increment renderer death counts. Older-run minidumps retain their original diagnostic scope; legacy startup minidumps without provenance do not receive this run's activity.

## Data and validation

The IPC bridge accepts only the current main window's main frame on the configured origin, at most 100 messages per second. Only typed, bounded fields are retained: no URLs, raw errors, server names, tokens, OAuth codes/state, account or project IDs. The follow-up strips inherited identity, request data, extras and breadcrumbs; it carries only the allowlisted diagnostic context. Existing native-event grouping and alert rules are unchanged. Diagnostic failures do not interrupt app work.

Run `node scripts/smoke-electron-diagnostics.cjs` from the inspector package for an isolated hidden-window Electron test. It uses the real preload and Sentry SDK with an in-memory transport, injects a child exit and synthetic native event, and checks correlation and serialized activity. It creates no production events and does not reproduce a real Chromium crash.
