import * as Sentry from "@sentry/node";
import { buildServerSentryConfig } from "../shared/sentry-config.js";
import { resolveEnvironment } from "./utils/log-events.js";

/**
 * Baked into the bundle by `server/tsup.config.ts` (`define`). It MUST stay a
 * literal `process.env.X` member expression — esbuild's `define` performs a
 * syntactic substitution and cannot see through a dynamic `process.env[name]`
 * lookup, which would leave the shipped server with no release tag.
 *
 * Under tsx in dev the define is absent and this reads the real environment,
 * where npm provides `npm_package_version` as the fallback below.
 */
const BAKED_VERSION = process.env.MCPJAM_INSPECTOR_VERSION;

/**
 * Sentry for the standalone Hono server (hosted, npx, Docker).
 *
 * MUST be an explicit call, not an import side-effect: `server/index.ts` loads
 * `.env` in its module body (`loadInspectorEnv`), and an import-time init would
 * be hoisted above that and read an empty environment. `index.ts` calls this
 * immediately after the env load.
 *
 * NOT called under Electron — the main-process `@sentry/electron` SDK already
 * owns the global carrier there, and a second init would fight it. Electron's
 * embedded server inherits that client.
 */
export function initServerSentry(): void {
  // The conventional opt-out for software that runs on the user's own
  // machine. `server/utils/analytics.ts` honors the same variable; anyone who
  // sets it has said no to telemetry, and crash reports are telemetry.
  const dnt = process.env.DO_NOT_TRACK;
  const enabled = !(dnt === "1" || dnt === "true");

  Sentry.init({
    ...buildServerSentryConfig({
      environment: resolveEnvironment(),
      release: blankToUndefined(BAKED_VERSION) ?? readEnv("npm_package_version"),
      deployment:
        process.env.VITE_MCPJAM_HOSTED_MODE === "true"
          ? "hosted"
          : "self_hosted",
      enabled,
      // Performance tracing off: this turns on for the first time across
      // every self-hosted install, and spans would multiply the quota
      // exposure of a change whose whole point is to see ERRORS.
      tracesSampleRate: 0,
    }),
    // Quota kill-knob. If a self-hosted noise pattern floods the project,
    // this can be dialed down by env var without a deploy.
    sampleRate: resolveErrorSampleRate(),
    integrations: (defaults) => [
      // `server/index.ts` installs its own `unhandledRejection` handler that
      // deliberately swallows the MCP SDK's "Connection closed" rejections
      // (the SDK rejects every pending promise when a connection drops —
      // routine, not a bug). The default integration would capture them all.
      ...defaults.filter(
        (i) =>
          i.name !== "OnUnhandledRejection" && i.name !== "OnUncaughtException",
      ),
      // Re-added EXPLICITLY with the exit forced on.
      //
      // @sentry/node 8's OnUncaughtException computes
      // `processWouldExit = userProvidedListenersCount === 0` and only exits
      // when `exitEvenIfOtherHandlersAreRegistered || processWouldExit`.
      // `server/index.ts` registers its own `uncaughtException` listener (to
      // mirror the crash into Axiom), so with the v8 default of `false` Sentry
      // would capture the exception and then let the process keep running in
      // an undefined state — silently turning a fail-fast crash into a zombie
      // server that no supervisor restarts.
      Sentry.onUncaughtExceptionIntegration({
        exitEvenIfOtherHandlersAreRegistered: true,
      }),
    ],
  });

  if (!enabled) {
    process.stderr.write(
      "[sentry] DO_NOT_TRACK is set; error reporting disabled\n",
    );
  }
}

/**
 * Read an env var, treating an empty string as unset.
 *
 * Container platforms (Railway, Docker Compose, GitHub Actions) routinely
 * materialize a declared-but-unset variable as `""`, which `??` does not
 * catch. That distinction is load-bearing below: `Number("")` is `0`, so
 * without this an empty `SENTRY_ERROR_SAMPLE_RATE` would silently drop 100%
 * of error events.
 */
function blankToUndefined(value: string | undefined): string | undefined {
  // `trim()` matters as much as the empty check: `Number(" ")` is 0, so a
  // whitespace-only value would otherwise sample 0% of errors.
  return value === undefined || value.trim() === "" ? undefined : value;
}

function readEnv(name: string): string | undefined {
  return blankToUndefined(process.env[name]);
}

/**
 * `SENTRY_ERROR_SAMPLE_RATE` in [0,1]. Anything unparseable or out of range
 * falls back to 1 — a typo must not silently turn reporting off.
 */
function resolveErrorSampleRate(): number {
  const raw = readEnv("SENTRY_ERROR_SAMPLE_RATE");
  if (raw === undefined) return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return 1;
  return parsed;
}
