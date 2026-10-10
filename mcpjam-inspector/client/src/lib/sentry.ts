import { createConvexQueryEventProcessor } from "./convex-query-diagnostics";
import * as Sentry from "@sentry/react";
import {
  buildClientSentryConfig,
  scrubSentryCredentials,
} from "../../../shared/sentry-config";
import {
  credentialRouteTemplate,
  scrubCredentialUrl,
  type LocationLike,
} from "../../../shared/credential-urls";
import { matchAppRoute } from "./app-routes";
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
 * The name a pageload or navigation span gets: the ROUTE TEMPLATE, never the
 * concrete path. Sentry's default is `location.pathname`, which puts a share
 * token (`/results/<token>`) or a customer's ids and names into the
 * transaction name — the most indexed, most widely shown field Sentry has.
 *
 * Credential routes come from the registry; everything else from the app's
 * route table, below `/p/:projectId` when the path is project-scoped. A path
 * no route claims keeps its route words and loses its names.
 */
export function sentryTransactionName(pathname: string): string {
  const credential = credentialRouteTemplate(pathname);
  if (credential) return credential;
  const project = /^\/p\/[^/]+(\/.*)?$/.exec(pathname);
  const logical = project ? (project[1] ?? "/") : pathname;
  const route = matchAppRoute(logical);
  if (route) {
    const template = `/${route.path}`.replace(/\/+$/, "");
    return `${project ? "/p/:projectId" : ""}${template}` || "/";
  }
  return scrubNamesFromUrl(pathname);
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
      if (filtered === null) return null;
      const processed = processQueryEvent(filtered, hint);
      // Last, so nothing added above can bring a credential back.
      return processed === null ? null : scrubSentryCredentials(processed);
    },
    // No replay integration here, on any surface. `syncSentryReplay` adds it
    // at the first moment the privacy level allows recording — never while
    // `pending`, never on `/results/<token>`. Starting it at init and stopping
    // it later would not do: `replay.stop()` FLUSHES the buffered segment,
    // which is exactly the content that had to stay out.
    integrations: [
      Sentry.browserTracingIntegration({
        // Named at the source: the concrete path never becomes a name, so
        // `beforeSendTransaction` has nothing to rescue.
        // `options.name` is the target pathname for both pageload and
        // navigation (the window still shows the old one when a navigation
        // span starts).
        beforeStartSpan: (options) => ({
          ...options,
          name: sentryTransactionName(options.name),
        }),
      }),
    ],
  });
  // The replay event lists every URL the replay visited: credentials out
  // always, names too short of `full`.
  Sentry.getClient()?.on?.("preprocessEvent", (event) => {
    if (event.type !== "replay_event") return;
    const replayEvent = event as { urls?: unknown };
    if (Array.isArray(replayEvent.urls)) {
      const scrub = shouldMaskAnalytics()
        ? scrubNamesFromUrl
        : scrubCredentialUrl;
      replayEvent.urls = replayEvent.urls.map((url: unknown) =>
        typeof url === "string" ? scrub(url) : url,
      );
    }
  });
}

/**
 * The Sentry half of `syncSessionRecording` (lib/session-privacy.ts): bring
 * Sentry Replay in line with the session's privacy level and the current
 * location.
 *
 * Sentry Replay records DOM and text exactly like rrweb, and unlike PostHog
 * it offers no hook over rrweb's page metadata or DOM events — so where the
 * result cannot be shown clean, it does not record at all:
 *
 *  - only at `full`. At `masked` (and `pending`, and `off`) it is held off;
 *    PostHog's masked profile is the masked replay.
 *  - never on a credential location (`isCredentialBearingPath`: path, query
 *    or fragment), at any level. `installRecorderNavigationGuard` stops it
 *    BEFORE a navigation onto one; this keeps it stopped and resumes it on
 *    the way out.
 *
 * The integration is added at the first moment recording is allowed. A
 * replay this guard stopped resumes in the mode it was in: a buffering
 * (error-sampled) replay keeps buffering rather than turning into a full
 * session recording.
 *
 * Never throws: this runs on a render path.
 */
let sentryReplayStoppedByGuard = false;
let sentryReplayResumeMode: "session" | "buffer" = "session";
let sentryReplayAdded = false;

type ReplayControls = ReturnType<typeof Sentry.replayIntegration> & {
  getRecordingMode?: () => "session" | "buffer" | undefined;
};

export function syncSentryReplay(location: string | LocationLike): void {
  try {
    if (!isErrorCaptureSurface()) return;
    const privacy = currentSessionPrivacy();
    const blocked = privacy !== "full" || isCredentialBearingPath(location);
    const client = Sentry.getClient();
    const replay = client?.getIntegrationByName?.<ReplayControls>("Replay");
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
      if (replay.getReplayId?.()) {
        sentryReplayStoppedByGuard = true;
        sentryReplayResumeMode =
          replay.getRecordingMode?.() === "buffer" ? "buffer" : "session";
      }
      replay.stop?.();
      return;
    }

    // `start()` bypasses `replaysSessionSampleRate` outright, so calling it on
    // every navigation would record 100% of the sessions that ever touched a
    // results link. Resume only the replay this guard interrupted, in the mode
    // it was in.
    if (sentryReplayStoppedByGuard) {
      sentryReplayStoppedByGuard = false;
      if (sentryReplayResumeMode === "buffer") replay.startBuffering?.();
      else replay.start?.();
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
