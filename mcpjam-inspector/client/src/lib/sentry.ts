import { createConvexQueryEventProcessor } from "./convex-query-diagnostics";
import * as Sentry from "@sentry/react";
import { buildClientSentryConfig } from "../../../shared/sentry-config";
import { HOSTED_MODE } from "./config";
import { desktopSentryFallback } from "./sentry-identity";
import {
  currentSessionPrivacy,
  isCredentialBearingPath,
  isErrorCaptureSurface,
  recordingSurface,
  scrubNamesFromUrl,
  SENTRY_REPLAY_OPTIONS,
  shouldMaskAnalytics,
} from "./session-privacy";

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
    // Paired with the `dist` every upload site passes. Without it the builds
    // that share this `release` are indistinguishable to Sentry.
    dist: __BUILD_SURFACE__,
    deployment: HOSTED_MODE ? "hosted" : "self_hosted",
    // CI's E2E build sets this. That build talks to prod Convex and would
    // otherwise report its test failures to the same project that pages us.
    enabled: import.meta.env.VITE_DISABLE_SENTRY !== "true",
    // The sample rates only. The integration itself is added later, by
    // `syncSentryReplay`, once the session's privacy level allows recording;
    // `off` surfaces (npx/Docker, dev builds) never add it.
    replayEnabled: recordingSurface() !== "off",
    // Lets `beforeSend` recognise a frame the browser stamped with the
    // document instead of a script — see shared/injected-script-frames.ts.
    // The origin, not the href: it is stable across SPA route changes, and
    // the frames carry whichever route was showing when the injected code
    // was evaluated.
    documentOrigin:
      typeof window === "undefined" ? undefined : window.location.origin,
  });
}

/**
 * Initialize Sentry for error tracking and session replay.
 * This should be called once at app startup, before mounting React.
 */
export function initSentry() {
  const config = resolveClientSentryConfig();
  const fallback = desktopSentryFallback();
  const processQueryEvent = createConvexQueryEventProcessor();
  Sentry.init({
    ...config,
    initialScope: {
      ...config.initialScope,
      ...fallback,
      tags: { ...config.initialScope.tags, ...fallback?.tags },
    },
    beforeSend: (event, hint) => {
      const filtered = config.beforeSend(event);
      return filtered === null ? null : processQueryEvent(filtered, hint);
    },
    // No replay integration here, on any surface. `syncSentryReplay` adds it
    // at the first moment the privacy level allows recording — never while
    // `pending`, never on `/results/<token>`. Starting it at init and stopping
    // it later would not do: `replay.stop()` FLUSHES the buffered segment,
    // which is exactly the content that had to stay out.
    integrations: [Sentry.browserTracingIntegration()],
  });
  // The replay event lists every URL the replay visited. Short of `full`,
  // names come out of those like everywhere else.
  Sentry.getClient()?.on?.("preprocessEvent", (event) => {
    if (event.type !== "replay_event" || !shouldMaskAnalytics()) return;
    const replayEvent = event as { urls?: unknown };
    if (Array.isArray(replayEvent.urls)) {
      replayEvent.urls = replayEvent.urls.map((url: unknown) =>
        typeof url === "string" ? scrubNamesFromUrl(url) : url,
      );
    }
  });
}

/**
 * The Sentry half of `syncSessionRecording` (lib/session-privacy.ts): bring
 * Sentry Replay in line with the session's privacy level and the current path.
 *
 * Sentry Replay records DOM and text exactly like rrweb, so gating only
 * PostHog would still leave `/results/<token>` — or a `pending` session — in a
 * Sentry replay. The integration is added at the first moment recording is
 * allowed, stopped while it is not, and resumed on the way out.
 *
 * Its options are the same at `full` and `masked` (`SENTRY_REPLAY_OPTIONS`
 * masks text, inputs and media at every level), so a level change needs no
 * restart here; the masked-only extras are applied frame by frame.
 *
 * Never throws: this runs on a render path.
 */
let sentryReplayStoppedByGuard = false;
let sentryReplayAdded = false;

export function syncSentryReplay(pathname: string): void {
  try {
    if (!isErrorCaptureSurface()) return;
    const privacy = currentSessionPrivacy();
    const blocked =
      privacy === "off" ||
      privacy === "pending" ||
      isCredentialBearingPath(pathname);
    const client = Sentry.getClient();
    const replay =
      client?.getIntegrationByName?.<
        ReturnType<typeof Sentry.replayIntegration>
      >("Replay");
    if (!replay) {
      // Constructed once, lazily. The sample rates set at init apply as it
      // sets up, exactly as if it had been there from the start.
      if (!blocked && !sentryReplayAdded && client) {
        sentryReplayAdded = true;
        Sentry.addIntegration(Sentry.replayIntegration(SENTRY_REPLAY_OPTIONS));
      }
      return;
    }

    if (blocked) {
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
  context?: { tags?: Record<string, string> },
): void {
  Sentry.captureException(error, context);
}

export function captureSentryMessage(
  message: string,
  context: Parameters<typeof Sentry.captureMessage>[1],
): void {
  Sentry.captureMessage(message, context);
}
