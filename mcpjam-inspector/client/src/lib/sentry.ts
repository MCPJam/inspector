import * as Sentry from "@sentry/react";
import { buildClientSentryConfig } from "../../../shared/sentry-config";
import { HOSTED_MODE } from "./config";
import { isErrorCaptureSurface } from "./PosthogUtils";

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
    // Same boundary PostHog replay uses, so the two cannot drift: a
    // self-hosted npx/Docker browser session is recorded by neither.
    replayEnabled: isErrorCaptureSurface(),
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
      ...(isErrorCaptureSurface() ? [Sentry.replayIntegration()] : []),
      Sentry.browserTracingIntegration(),
    ],
  });
}
