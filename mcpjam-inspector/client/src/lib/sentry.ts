import { rebuildSentryFrameLocations } from "../../../shared/strict-sentry";
import {
  strictSentryRequired,
  blockSentryReplay,
  browserSentryEnvironment,
  browserSentryOptions,
  withStrictSentryTransport,
} from "./strict-sentry-boundary";
import { createConvexQueryEventProcessor } from "./convex-query-diagnostics";
import { createSentryDropPolicy } from "./sentry-drop-policy";
import { subscribeTelemetryPolicy } from "./telemetry-context";
import { telemetryOptedOut } from "../../../shared/sentry-identity";
import { matchAppRoute } from "./app-routes";
import { parseProjectPath } from "./project-route";
import * as Sentry from "@sentry/react";
import {
  buildClientSentryConfig,
  scrubSentryCredentials,
} from "../../../shared/sentry-config";
import {
  credentialRouteTemplate,
  URL_BEARING_FIELDS,
  type LocationLike,
} from "../../../shared/credential-urls";
import { HOSTED_MODE } from "./config";
import {
  desktopSentryFallback,
  filterSentryEventIdentity,
} from "./sentry-identity";
import { stampSentryEvent, stampSentryBreadcrumb, stampSentrySpanStart, stampSentrySpanJson } from "./sentry-capture-policy";
import {
  currentSessionPrivacy,
  isCredentialBearingPath,
  isErrorCaptureSurface,
  recordingSurface,
  SENTRY_REPLAY_OPTIONS,
} from "./session-privacy";

/**
 * Resolve the config the browser bundle inits with.
 *
 * The environment is the strict boundary's, so full and rebuilt events from
 * one deployment land in the same Sentry environment.
 */
export function resolveClientSentryConfig() {
  return buildClientSentryConfig({
    environment: browserSentryEnvironment(),
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
    // was evaluated. Breadcrumbs use it too: a request to this origin keeps
    // its path, a request anywhere else only its origin.
    documentOrigin:
      typeof window === "undefined" ? undefined : window.location.origin,
  });
}

/**
 * The name a pageload or navigation span gets. Sentry's default is
 * `location.pathname`, which puts a share token (`/results/<token>`) into
 * the transaction name, the most indexed, most widely shown field Sentry has.
 * A credential route is named by its template (`/results/:runToken`) from
 * the registry; any other path keeps its words and loses only credentials.
 * Names come out short of `full` on the way out
 * (`filterSentryTransactionContent`).
 */
export function sentryTransactionName(pathname: string): string {
  const project = parseProjectPath(pathname);
  const route = matchAppRoute(project?.relativePath ?? pathname);
  if (route) return `${project ? "/p/:projectId" : ""}/${route.path}`.replace(/\/{2,}/g, "/");
  return credentialRouteTemplate(pathname) ?? "unknown_operation";
}

/**
 * Credentials out of an event a hook cannot drop (a replay event, which
 * never reaches `beforeSend`), in place. When the walker cannot finish, its
 * URL-bearing fields go.
 */
function scrubSentryCredentialsInPlace(event: Record<string, unknown>): void {
  const scrubbed = scrubSentryCredentials(event) as Record<
    string,
    unknown
  > | null;
  if (!scrubbed) {
    for (const field of URL_BEARING_FIELDS) delete event[field];
    return;
  }
  for (const key of Object.keys(event)) {
    if (!(key in scrubbed)) delete event[key];
  }
  Object.assign(event, scrubbed);
}

function fullSentrySerializer(
  config: ReturnType<typeof resolveClientSentryConfig>,
  processQueryEvent: ReturnType<typeof createConvexQueryEventProcessor>,
) {
  return (type: string, payload: Record<string, unknown>, names: boolean): object | null => {
        const event = payload as Sentry.Event;
        let clean: Sentry.Event | null = event;
        if (type === "event") clean = config.beforeSend(event);
        if (type === "event" && clean && clean.type === undefined) clean = processQueryEvent({ ...clean, type: undefined }, {}) as Sentry.Event | null;
        if (!clean) return null;
        filterSentryEventIdentity(clean, names);
        if (type === "span") {
          const span = scrubSentryCredentials(payload);
          return span ? rebuildSentryFrameLocations(span, browserSentryOptions()) : null;
        }
        if (type === "replay_event") delete clean.breadcrumbs;
        else if (clean.breadcrumbs) clean.breadcrumbs = clean.breadcrumbs
          .map((crumb) => config.beforeBreadcrumb(crumb)).filter((crumb) => crumb !== null);
        if (type === "transaction") clean = config.beforeSendTransaction(clean);

        if (!clean) return null;
        scrubSentryCredentialsInPlace(clean as Record<string, unknown>);
        return rebuildSentryFrameLocations(clean, browserSentryOptions());
      };
}

/**
 * Initialize Sentry for error tracking and session replay.
 * This should be called once at app startup, before mounting React.
 *
 * Identity starts id-only: the initial scope carries at most the desktop
 * installation id, and `setSentryActor` adds name and email only under the
 * current actor's grant. Every outbound event is filtered again here, and
 * every credential comes out of it last (`scrubSentryCredentials`).
 */
export function initSentry() {
  const config = resolveClientSentryConfig();
  const fallback = desktopSentryFallback();
  const processQueryEvent = createConvexQueryEventProcessor();
  const drop = createSentryDropPolicy(typeof window === "undefined" ? undefined : window.location.origin);
  Sentry.init({
    ...config,
    initialScope: {
      ...config.initialScope,
      ...fallback,
      tags: { ...config.initialScope.tags, ...fallback?.tags },
    },
    beforeSend: undefined,
    beforeSendTransaction: undefined,
    beforeBreadcrumb: config.beforeBreadcrumb,
    beforeSendSpan: stampSentrySpanJson,
    transport: (options) => withStrictSentryTransport(
      Sentry.makeFetchTransport(options),
      fullSentrySerializer(config, processQueryEvent),
      async () => {
        if (!config.enabled || telemetryOptedOut(navigator.doNotTrack)) return true;
        if (!window.isElectron) return false;
        try { return (await window.electronAPI?.sentry?.isDisabled?.()) !== false; }
        catch { return true; }
      },
      options.recordDroppedEvent,
    ),
    // No replay integration here, on any surface. `syncSentryReplay` adds it
    // at the first moment the privacy level allows recording — never while
    // `pending`, never on `/results/<token>`. Starting it at init and stopping
    // it later would not do: `replay.stop()` FLUSHES the buffered segment,
    // which is exactly the content that had to stay out.
    integrations: [
      Sentry.browserTracingIntegration({
        // Named at the source, so a credential path never becomes a span
        // name. `options.name` is the target pathname for both pageload and
        // navigation (the window still shows the old one when a navigation
        // span starts).
        beforeStartSpan: (options) => ({
          ...options,
          name: sentryTransactionName(options.name),
        }),
      }),
    ],
  });
  Sentry.getClient()?.on?.("preprocessEvent", (event, hint) =>
    stampSentryEvent(event, hint, drop(event as Sentry.ErrorEvent, hint ?? {})),
  );
  Sentry.getClient()?.on?.("spanStart", stampSentrySpanStart);
  Sentry.getClient()?.on?.("beforeAddBreadcrumb", stampSentryBreadcrumb);
  subscribeTelemetryPolicy(() => syncSentryReplay(window.location));

}

/**
 * The Sentry half of `syncSessionRecording` (lib/session-privacy.ts): bring
 * Sentry Replay in line with the session's privacy level and the current
 * location.
 *
 * Sentry Replay records DOM and text exactly like rrweb, so gating only
 * PostHog would still leave a credential page, or a `pending` session, in a
 * Sentry replay. It records only at `full`, with `SENTRY_REPLAY_OPTIONS`, and is held off:
 *
 *  - while `pending` and at `off`;
 *  - on a credential location (`isCredentialBearingPath`: path, query or
 *    fragment), at any level. `installRecorderNavigationGuard` stops it
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
/** The guard's `stop()` calls still flushing, as one promise. */
let pendingSentryStop: Promise<unknown> | null = null;
/** Whether the latest sync found the location blocked. */
let lastSyncBlocked = false;

type ReplayControls = ReturnType<typeof Sentry.replayIntegration> & {
  getRecordingMode?: () => "session" | "buffer" | undefined;
};

export function syncSentryReplay(location: string | LocationLike): void {
  try {
    if (!isErrorCaptureSurface()) return;
    const privacy = currentSessionPrivacy();
    const blocked =
      privacy !== "full" ||
      strictSentryRequired() ||
      recordingSurface() !== "hosted" ||
      isCredentialBearingPath(location);
    lastSyncBlocked = blocked;
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
      blockSentryReplay(replay.getReplayId?.());
      if (replay.getReplayId?.()) {
        sentryReplayStoppedByGuard = true;
        sentryReplayResumeMode =
          replay.getRecordingMode?.() === "buffer" ? "buffer" : "session";
      }
      const stopping: unknown = replay.stop?.();
      if (
        stopping &&
        typeof (stopping as Promise<unknown>).then === "function"
      ) {
        const current = Promise.resolve(stopping).catch(() => {
          // A stop that failed to flush is still over; the resume only waits
          // for it to settle.
        });
        // A second `stop()` while the first is still flushing returns at
        // once (the replay is already stopping), so it must not stand in for
        // the first: a resume waits for every stop still in flight.
        const settled = pendingSentryStop
          ? Promise.all([pendingSentryStop, current])
          : current;
        pendingSentryStop = settled;
        void settled.then(() => {
          if (pendingSentryStop === settled) pendingSentryStop = null;
        });
      }
      return;
    }

    // `start()` bypasses `replaysSessionSampleRate` outright, so calling it on
    // every navigation would record 100% of the sessions that ever touched a
    // results link. Resume only the replay this guard interrupted, in the mode
    // it was in.
    if (sentryReplayStoppedByGuard) {
      sentryReplayStoppedByGuard = false;
      const mode = sentryReplayResumeMode;
      const resume = () => {
        if (mode === "buffer") replay.startBuffering?.();
        else replay.start?.();
      };
      // `stop()` flushes asynchronously, and a `start()` issued while it is
      // still in flight is ignored — a quick in-and-out of a credential page
      // would otherwise leave the replay stopped for good. Wait for it, then
      // resume only if nothing has blocked the location since.
      afterPendingSentryStops(() => {
        if (lastSyncBlocked) {
          sentryReplayStoppedByGuard = true;
          return;
        }
        resume();
      });
    }
  } catch {
    // See doc comment — a failed guard must not break the render.
  }
}

/**
 * Runs `then` once no guard `stop()` is flushing: now if none is, otherwise
 * after the pending ones settle — and after any stop issued meanwhile.
 */
function afterPendingSentryStops(then: () => void): void {
  const stopping = pendingSentryStop;
  if (!stopping) {
    then();
    return;
  }
  void stopping.then(() => afterPendingSentryStops(then));
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
