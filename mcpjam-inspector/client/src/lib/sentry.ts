import { createConvexQueryEventProcessor } from "./convex-query-diagnostics";
import * as Sentry from "@sentry/react";
import { buildClientSentryConfig } from "../../../shared/sentry-config";
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
    // was evaluated.
    documentOrigin:
      typeof window === "undefined" ? undefined : window.location.origin,
  });
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

function scrubSpanValue(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (HOST_KEYS.has(key)) return scrubHostname(value);
  if (SELECTOR_KEY.test(key)) return stripSelectorAttributes(value);
  if (value.startsWith("/")) return scrubNamesFromUrl(value);
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
 * Initialize Sentry for error tracking and session replay.
 * This should be called once at app startup, before mounting React.
 *
 * Identity starts id-only: the initial scope carries at most the desktop
 * installation id, and `setSentryActor` adds name and email only under the
 * current actor's grant. Every outbound event is filtered again here.
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
      // it in `transaction` as well as in `request.url`.
      return processed === null
        ? null
        : filterSentryTransactionContent(
            filterSentryEventUrl(
              filterSentryEventIdentity(processed, allowNamesFor(hint)),
              hint,
            ),
            hint,
          );
    },
    beforeSendTransaction: (event, hint) =>
      filterSentryTransactionContent(
        filterSentryEventUrl(
          filterSentryEventIdentity(event, allowNamesFor(hint)),
          hint,
        ),
        hint,
      ),
    beforeBreadcrumb: (breadcrumb) => filterSentryBreadcrumb(breadcrumb),
    // Replay recordings' rrweb events cannot be edited as they are recorded;
    // the page URL in their Meta events is scrubbed on the way out.
    transport: (options) =>
      withRecordingFilter(Sentry.makeFetchTransport(options)),
    // No replay integration here, on any surface. `syncSentryReplay` adds it
    // at the first moment the privacy level allows recording — never while
    // `pending`, never on `/results/<token>`. Starting it at init and stopping
    // it later would not do: `replay.stop()` FLUSHES the buffered segment,
    // which is exactly the content that had to stay out.
    integrations: [Sentry.browserTracingIntegration()],
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
  // The scope adds the page URL and transaction name to the replay event
  // after that; replay events never reach `beforeSend`, so they are scrubbed
  // here, on the same terms as an error event's.
  Sentry.getClient()?.on?.("postprocessEvent", (event, hint) => {
    if (event.type !== "replay_event") return;
    filterSentryTransactionContent(filterSentryEventUrl(event, hint), hint);
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
