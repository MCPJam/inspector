import * as Sentry from "@sentry/react";
import { useEffect } from "react";
import {
  createBrowserRouter,
  createRoutesFromChildren,
  matchRoutes,
  useLocation,
  useNavigationType,
} from "react-router";
import { buildClientSentryConfig } from "../../../shared/sentry-config";
import { HOSTED_MODE } from "./config";
import {
  isCredentialBearingPath,
  isErrorCaptureSurface,
  shouldRecordSession,
} from "./PosthogUtils";

let wrappedCreateBrowserRouter: typeof createBrowserRouter | null = null;

/**
 * `createBrowserRouter`, instrumented — build the app router with this.
 *
 * Wrapped on FIRST CALL, never at module scope. `wrapCreateBrowserRouterV7`
 * hands back `createBrowserRouter` unwrapped when the tracing integration's
 * `setup()` has not run yet, and says so only behind `DEBUG_BUILD` — silence in
 * production. Module scope always loses that race: `router.tsx` imports this
 * file, so it evaluates before `main.tsx` reaches `initSentry()`.
 *
 * A no-op wrap is worse than none: the v7 integration builds its inner
 * browser-tracing with `instrumentNavigation: false` and re-implements
 * navigation spans through this wrapper, so an inert wrapper emits nothing.
 */
export function createSentryBrowserRouter(
  ...args: Parameters<typeof createBrowserRouter>
) {
  wrappedCreateBrowserRouter ??=
    Sentry.wrapCreateBrowserRouterV7(createBrowserRouter);
  return wrappedCreateBrowserRouter(...args);
}

/**
 * Resolve the config the browser bundle inits with.
 *
 * `import.meta.env.PROD` rather than `process.env.NODE_ENV`: the renderer has
 * no `process`, and the packaged desktop app never sets NODE_ENV — the old
 * NODE_ENV check made every desktop and hosted event report `environment:
 * "dev"`.
 */
export function resolveClientSentryConfig() {
  return buildClientSentryConfig({
    environment: import.meta.env.PROD ? "prod" : "dev",
    release: __APP_VERSION__,
    deployment: HOSTED_MODE ? "hosted" : "self_hosted",
    // Literally the same predicate PostHog's `disable_session_recording`
    // uses, so the two recorders cannot drift: a self-hosted npx/Docker
    // browser session, and any session that LOADS on `/results/<token>`, is
    // recorded by neither.
    replayEnabled: shouldRecordSession(),
  });
}

/**
 * Initialize Sentry for error tracking and session replay.
 * This should be called once at app startup, before mounting React.
 */
export function initSentry() {
  const config = resolveClientSentryConfig();
  Sentry.init({
    ...config,
    integrations: [
      // Don't even load the replay integration where replay is not permitted;
      // zero sample rates alone would still ship the recorder code and open
      // its buffers.
      //
      // `shouldRecordSession()`, not just the platform check: on a hard load
      // onto `/results/<token>` the runtime guard below is too late, because
      // `replay.stop()` FLUSHES the buffered segment — which is the
      // token-bearing page itself. Such a session simply has no replay.
      ...(shouldRecordSession() ? [Sentry.replayIntegration()] : []),
      // Paired with `createSentryBrowserRouter` above: the hooks report the
      // navigation, the wrapper supplies the route it resolved to.
      Sentry.reactRouterV7BrowserTracingIntegration({
        useEffect,
        useLocation,
        useNavigationType,
        createRoutesFromChildren,
        matchRoutes,
      }),
    ],
  });
}

/**
 * The Sentry half of the bearer-credential carve-out.
 *
 * Sentry Replay records DOM and text exactly like rrweb, so gating only
 * PostHog would still leave `/results/<token>` in a Sentry replay. Stop on the
 * way in, resume on the way out.
 *
 * Never throws: this runs on a render path, and the replay integration is
 * absent entirely on surfaces where replay is not permitted.
 */
let sentryReplayStoppedByGuard = false;

export function syncSentryReplayForPath(pathname: string): void {
  try {
    if (!isErrorCaptureSurface()) return;
    const replay = Sentry.getClient()?.getIntegrationByName?.<
      ReturnType<typeof Sentry.replayIntegration>
    >("Replay");
    if (!replay) return;

    if (isCredentialBearingPath(pathname)) {
      // Arm the resume only if a replay was actually running, so leaving the
      // route cannot manufacture one — but never DISARM here. `stop()` clears
      // the replay id, so navigating `/results/a` → `/results/b` would
      // otherwise forget that this guard is what stopped the recording, and
      // the eventual exit would never resume it.
      if (replay.getReplayId?.()) sentryReplayStoppedByGuard = true;
      replay.stop?.();
      return;
    }

    // `start()` bypasses `replaysSessionSampleRate` outright, so calling it on
    // every navigation would record 100% of the sessions that ever touched a
    // results link. Resume only the replay this guard interrupted.
    if (sentryReplayStoppedByGuard) {
      sentryReplayStoppedByGuard = false;
      replay.start?.();
    }
  } catch {
    // See doc comment — a failed guard must not break the render.
  }
}

/**
 * Report a caught problem that is worth an alert but must not stop the app.
 *
 * Thin wrapper over `Sentry.captureException` so callers do not each import
 * the SDK — and so the "we chose to keep running" cases are visibly one thing
 * rather than scattered raw SDK calls that read like error handling.
 */
export function captureSentryException(
  error: Error,
  context?: { tags?: Record<string, string> }
): void {
  Sentry.captureException(error, context);
}
