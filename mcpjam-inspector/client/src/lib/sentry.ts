import { createConvexQueryEventProcessor } from "./convex-query-diagnostics";
import * as Sentry from "@sentry/react";
import {
  buildClientSentryConfig,
  scrubSentryCredentials,
} from "../../../shared/sentry-config";
import {
  credentialRouteTemplate,
  scrubCredentialUrl,
  URL_BEARING_FIELDS,
  type LocationLike,
} from "../../../shared/credential-urls";
import { HOSTED_MODE } from "./config";
import {
  desktopSentryFallback,
  filterSentryEventIdentity,
} from "./sentry-identity";
import { withRecordingFilter } from "./sentry-recording-filter";
import { telemetryNamesAllowed } from "./telemetry-context";
import {
  scrubHostname,
  scrubUrlsInText,
} from "../../../shared/telemetry-privacy";
import {
  currentSessionPrivacy,
  filterSentryBreadcrumb,
  isCredentialBearingPath,
  isErrorCaptureSurface,
  recordingSurface,
  scrubNamesFromUrl,
  SENTRY_REPLAY_OPTIONS,
  shouldMaskAnalytics,
  stripSelectorAttributes,
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
  return credentialRouteTemplate(pathname) ?? scrubCredentialUrl(pathname);
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

/**
 * Whether names were allowed when an event was captured, keyed by the hint
 * object Sentry threads through every stage of one event — `preprocessEvent`,
 * `postprocessEvent` and `beforeSend` for errors and transactions, the first
 * two for replay events.
 */
const namesAllowedAtCapture = new WeakMap<object, boolean>();
/** Whether the session was short of `full` when an event was captured. */
const maskedAtCapture = new WeakMap<object, boolean>();

/**
 * Names leave only if they were allowed when the event was captured AND are
 * allowed now. An event with no capture-time record is id-only.
 */
function allowNamesFor(hint: unknown): boolean {
  if (typeof hint !== "object" || hint === null) return false;
  return namesAllowedAtCapture.get(hint) === true && telemetryNamesAllowed();
}

/**
 * Short of `full` at capture or now, the page URL an event reports, and the
 * `Referer` it sent, lose their names, as every other URL does
 * (`scrubNamesFromUrl`). Breadcrumbs were already filtered as they were
 * recorded (`filterSentryBreadcrumb`).
 */
function filterSentryEventUrl<
  T extends { request?: { url?: unknown; headers?: Record<string, string> } },
>(event: T, hint: unknown): T {
  const masked =
    shouldMaskAnalytics() ||
    typeof hint !== "object" ||
    hint === null ||
    maskedAtCapture.get(hint) !== false;
  if (!masked || !event.request) return event;
  const request = { ...event.request };
  if (typeof request.url === "string") {
    request.url = scrubNamesFromUrl(request.url);
  }
  if (request.headers) {
    request.headers = Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [
        name,
        name.toLowerCase() === "referer" && typeof value === "string"
          ? scrubNamesFromUrl(value)
          : value,
      ]),
    );
  }
  event.request = request;
  return event;
}

const HOST_KEYS = new Set(["server.address", "net.peer.name", "http.host"]);
// Web-vitals attributes that name the element they measured, as a CSS
// selector whose attribute values are the page's text (`[title="…"]`).
const SELECTOR_KEY = /^(?:lcp\.element|cls\.source\.\d+|inp\.target|ui\.)/;

// A request span named after a relative URL: `GET /servers/acme`.
const METHOD_AND_PATH = /^([A-Z]+) (\/\S*)$/;

function scrubSpanValue(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (HOST_KEYS.has(key)) return scrubHostname(value);
  if (SELECTOR_KEY.test(key)) return stripSelectorAttributes(value);
  // A request's query and fragment, recorded apart from its URL.
  if (key === "http.query") {
    const query = value.replace(/^\?/, "");
    return query ? scrubNamesFromUrl(`/?${query}`).slice(1) : value;
  }
  if (key === "http.fragment") return "";
  if (value.startsWith("/")) return scrubNamesFromUrl(value);
  const request = METHOD_AND_PATH.exec(value);
  if (request) return `${request[1]} ${scrubNamesFromUrl(request[2])}`;
  return scrubUrlsInText(value);
}

function scrubSpanData(data: unknown): unknown {
  if (typeof data !== "object" || data === null) return data;
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      scrubSpanValue(key, value),
    ]),
  );
}

interface SentrySpanLike {
  description?: unknown;
  data?: unknown;
}

/**
 * A transaction captured short of `full`: performance spans keep their
 * timing but lose the names they carry — resource and request URLs, peer
 * host names, and the attribute values inside web-vitals element selectors.
 */
function filterSentryTransactionContent<
  T extends {
    spans?: SentrySpanLike[];
    contexts?: { trace?: SentrySpanLike };
    transaction?: unknown;
  },
>(event: T, hint: unknown): T {
  const masked =
    shouldMaskAnalytics() ||
    typeof hint !== "object" ||
    hint === null ||
    maskedAtCapture.get(hint) !== false;
  if (!masked) return event;
  const scrubSpan = <S extends SentrySpanLike>(span: S): S => ({
    ...span,
    ...(typeof span.description === "string"
      ? { description: scrubSpanValue("description", span.description) }
      : {}),
    ...(span.data ? { data: scrubSpanData(span.data) } : {}),
  });
  if (Array.isArray(event.spans)) event.spans = event.spans.map(scrubSpan);
  if (event.contexts?.trace) {
    event.contexts = {
      ...event.contexts,
      trace: scrubSpan(event.contexts.trace),
    };
  }
  if (typeof event.transaction === "string") {
    event.transaction = scrubSpanValue("transaction", event.transaction);
  }
  return event;
}

/**
 * A span on its own way out: a transaction's child, or a standalone span
 * (web vitals such as INP), which passes through neither `beforeSend` nor
 * `beforeSendTransaction`. A standalone span carries the scope's
 * transaction name, the raw path, in `data.transaction`. Short of `full` its
 * names come out as a transaction's spans' do; its credentials always do,
 * and when the walker cannot finish, its description and data go.
 */
export function filterSentrySpan<T extends SentrySpanLike>(span: T): T {
  const named = shouldMaskAnalytics()
    ? {
        ...span,
        ...(typeof span.description === "string"
          ? { description: scrubSpanValue("description", span.description) }
          : {}),
        ...(span.data ? { data: scrubSpanData(span.data) } : {}),
      }
    : span;
  const clean = scrubSentryCredentials(named);
  if (clean) return clean;
  const { description: _description, data: _data, ...rest } = named;
  return { ...rest, data: {} } as T;
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
      // `browserTracingIntegration` names the scope's transaction after the
      // raw path on every pageload and navigation, so an error event carries
      // it in `transaction` as well as in `request.url`. The credential walker
      // runs last, so nothing added above can bring a credential back.
      return processed === null
        ? null
        : scrubSentryCredentials(
            filterSentryTransactionContent(
              filterSentryEventUrl(
                filterSentryEventIdentity(processed, allowNamesFor(hint)),
                hint,
              ),
              hint,
            ),
          );
    },
    // Spans carry request URLs (`GET /api/web/score/runs/<token>`), so the
    // config's credential pass runs last here too.
    beforeSendSpan: (span) => filterSentrySpan(span),
    beforeSendTransaction: (event, hint) =>
      config.beforeSendTransaction(
        filterSentryTransactionContent(
          filterSentryEventUrl(
            filterSentryEventIdentity(event, allowNamesFor(hint)),
            hint,
          ),
          hint,
        ),
      ),
    // The config's content scrub first (`shared/sentry-config.ts`: console
    // arguments and request URLs keep their shape, not their values), then
    // the privacy level's filter.
    beforeBreadcrumb: (breadcrumb) => {
      const scrubbed = config.beforeBreadcrumb(breadcrumb);
      return scrubbed === null ? null : filterSentryBreadcrumb(scrubbed);
    },
    // Replay recordings' rrweb events cannot be edited as they are recorded;
    // the page URL in their Meta events is scrubbed on the way out.
    transport: (options) =>
      withRecordingFilter(Sentry.makeFetchTransport(options)),
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
  // Capture-time identity, for every event type. `postprocessEvent` runs
  // after the scope's user is applied — replay events included, which never
  // reach `beforeSend` — so it is where the outbound filter covers them all.
  Sentry.getClient()?.on?.("preprocessEvent", (_event, hint) => {
    if (!hint) return;
    namesAllowedAtCapture.set(hint, telemetryNamesAllowed());
    maskedAtCapture.set(hint, shouldMaskAnalytics());
  });
  Sentry.getClient()?.on?.("postprocessEvent", (event, hint) => {
    filterSentryEventIdentity(event, allowNamesFor(hint));
  });
  // The replay event lists every URL the replay visited. They lose their
  // credentials at every level, and short of `full` their names too, like
  // everywhere else.
  Sentry.getClient()?.on?.("preprocessEvent", (event) => {
    if (event.type !== "replay_event") return;
    const scrubUrl = shouldMaskAnalytics()
      ? scrubNamesFromUrl
      : scrubCredentialUrl;
    const replayEvent = event as { urls?: unknown };
    if (Array.isArray(replayEvent.urls)) {
      replayEvent.urls = replayEvent.urls.map((url: unknown) =>
        typeof url === "string" ? scrubUrl(url) : url,
      );
    }
  });
  // The scope adds the page URL and transaction name to the replay event
  // after that; replay events never reach `beforeSend`, so they are scrubbed
  // here, on the same terms as an error event's, credentials last. A segment
  // the guard's `stop()` flushes can leave after the address bar has moved
  // onto a credential page.
  Sentry.getClient()?.on?.("postprocessEvent", (event, hint) => {
    if (event.type !== "replay_event") return;
    filterSentryTransactionContent(filterSentryEventUrl(event, hint), hint);
    scrubSentryCredentialsInPlace(event as Record<string, unknown>);
  });
}

/**
 * The Sentry half of `syncSessionRecording` (lib/session-privacy.ts): bring
 * Sentry Replay in line with the session's privacy level and the current
 * location.
 *
 * Sentry Replay records DOM and text exactly like rrweb, so gating only
 * PostHog would still leave a credential page, or a `pending` session, in a
 * Sentry replay. It records at `full` and `masked` (its options are the same
 * at both, `SENTRY_REPLAY_OPTIONS`; the masked-only extras are applied frame
 * by frame and in its transport), and is held off:
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
      privacy === "off" ||
      privacy === "pending" ||
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
