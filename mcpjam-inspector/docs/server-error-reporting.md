# Server error reporting

## Who owns Sentry capture

**The logger. Only the logger.**

- `Hono.onError` → `appLogger.error(...)` → `Sentry.captureException`. Route
  handlers never call `captureException` themselves.
- `logger.event(...)` / `logger.systemEvent(...)` capture **only** with an
  explicit `{ sentry: true }`, at the callsite that owns the error.
- `logger.warn` does **not** capture. It used to, and across thousands of
  self-hosted installs that was the single largest quota-spike vector we had —
  a warning is by definition something we chose not to treat as a failure.
  Warnings go to Axiom, where they are queryable and cheap. A warning that
  genuinely needs an issue should be an explicit
  `logger.event(..., { error, sentry: true })`.

If you find yourself importing `@sentry/node` in a route, you are adding a
double-capture. Use the logger.

## Process-level handlers

| Signal              | Capture                                           | Log                                     |
| ------------------- | ------------------------------------------------- | --------------------------------------- |
| `uncaughtException` | Sentry's `OnUncaughtException` integration         | `process.uncaught_exception` → Axiom    |
| `unhandledRejection`| our handler, via `{ sentry: true }`               | `process.unhandled_rejection` → Axiom   |

`OnUnhandledRejection` is filtered out of the default integrations on purpose.
`server/index.ts` installs its own handler that deliberately swallows the MCP
SDK's `"Connection closed"` rejections — the SDK rejects every pending promise
when a connection drops, which is routine, not a bug. The default integration
would capture all of them.

`OnUncaughtException` stays: its capture-then-exit behavior is what we want.
Our own `uncaughtException` handler exists only so the crash also lands in
Axiom, and it deliberately does **not** pass `sentry: true`.

## Init ordering

`initServerSentry()` is an explicit call from `server/index.ts`, made
immediately after `loadInspectorEnv()`. It cannot be an import side-effect:
imports are hoisted above the env load, so the init would read an empty
environment.

It is **not** called under Electron — `@sentry/electron/main` already owns the
global carrier there and the embedded server inherits that client.

## Knobs

| Variable                   | Effect                                                    |
| -------------------------- | --------------------------------------------------------- |
| `DO_NOT_TRACK=1` / `=true` | Disables reporting entirely (same opt-out analytics honors)|
| `SENTRY_ERROR_SAMPLE_RATE` | `[0,1]`; defaults to 1. Quota brake, no deploy required.   |
| `ENVIRONMENT`              | Sentry `environment` tag, via `resolveEnvironment()`       |
| `VITE_MCPJAM_HOSTED_MODE`  | `deployment` tag: `hosted` vs `self_hosted`                |

An **empty-string** value counts as unset for the version and sample-rate
reads. Container platforms materialize declared-but-unset variables as `""`,
and `Number("")` is `0` — without that normalization an empty
`SENTRY_ERROR_SAMPLE_RATE` would silently drop 100% of error events.

Performance tracing is off (`tracesSampleRate: 0`). This init lands on every
self-hosted install at once; spans would multiply the quota exposure of a
change whose whole point is to see errors.

## Rollout risk plan

This is the first time the OSS server actually reports — the previous
`Sentry.init` was dead code (an import side-effect hoisted above the env load).
Volume is genuinely unknown.

1. **Watch the `inspector-server` project for 48h** after deploy.
2. If volume is uncomfortable, dial `SENTRY_ERROR_SAMPLE_RATE` down, or set a
   per-project rate limit in Sentry. Both are config, not deploys.
3. If self-hosted MCP-connection noise dominates, add a `beforeSend` that drops
   `/Connection closed|McpError|ECONNREFUSED/` **only** when
   `deployment: self_hosted` — hosted must keep reporting those.

The `deployment` tag exists precisely so step 3 can be scoped rather than
blanket.
