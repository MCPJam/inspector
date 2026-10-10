/**
 * Session privacy levels: what session replay and product analytics may
 * record in this browser session.
 *
 *   - `off`    — no replay at all. npx/Docker installs, `electron-forge start`,
 *                and builds with `VITE_DISABLE_POSTHOG_LOCAL`.
 *   - `masked` — replay of layout and interaction only: every text node and
 *                input masked, media blocked, no console logs, no network
 *                headers or bodies, and name-like URL segments replaced.
 *                Autocapture masks element text and attributes.
 *   - `full`   — replay as it has always been: inputs and annotated secret
 *                surfaces masked, everything else visible.
 *
 * Who gets which level is `resolveSessionPrivacy`, from the backend's answer
 * for the contexts in view (`telemetryPrivacy:getContext`, read by
 * `useTelemetryPrivacyContext`). The level is applied to BOTH recorders —
 * PostHog here (`syncSessionRecording`), Sentry Replay in `sentry.ts`
 * (`syncSentryReplay`) — from the same module state, so the two cannot
 * disagree. `docs/session-replay-masking.md` has the table.
 *
 * Fail closed. Nothing records until the level is known; an answer that does
 * not arrive becomes `masked` (`useSessionPrivacy`), never `full`. The PostHog
 * relay enforces the same policy again on the server, so a client that gets
 * this wrong still cannot upload an unmasked replay through it.
 */
import { HOSTED_MODE } from "./config";
import {
  MASKED_REPLAY_BLOCKED_TAGS,
  maskReplayAttribute,
  scrubNamesFromUrl,
  type TelemetryRecording,
} from "../../../shared/telemetry-privacy";

export {
  APP_ROUTE_WORDS,
  maskReplayAttribute,
  scrubNamesFromUrl,
} from "../../../shared/telemetry-privacy";

export type PrivacyLevel = "off" | "masked" | "full";

/** A level, or `pending`: not known yet, and nothing records meanwhile. */
export type SessionPrivacy = PrivacyLevel | "pending";

/**
 * Whether this surface records session replays and captures exceptions.
 *
 * Hosted (app.mcpjam.com) and the packaged desktop app only. npx/Docker
 * installs run on someone else's machine against their own MCP servers —
 * recording those sessions is not ours to do, and the volume from every OSS
 * install would swamp the quota that makes hosted replay useful.
 */
export function isErrorCaptureSurface(): boolean {
  return HOSTED_MODE || isPackagedDesktop();
}

/**
 * A *shipped* desktop build, as opposed to `electron-forge start`.
 *
 * `src/preload.ts` exposes `isElectron: true` unconditionally, so it cannot
 * tell a packaged app from a developer's local run. `import.meta.env.PROD`
 * can: the dev renderer is served by the vite dev server, the packaged one is
 * a `vite build` output. Without this check every `electron-forge start`
 * session would stream renderer DOM and text into the production Sentry and
 * PostHog projects — and the boundary this file documents is *packaged*
 * desktop, not "anything with a preload attached".
 *
 * `HOSTED_MODE` needs no equivalent: it comes from `VITE_MCPJAM_HOSTED_MODE`,
 * which only the deployed bundle's config sets.
 */
function isPackagedDesktop(): boolean {
  return (
    import.meta.env.PROD &&
    typeof window !== "undefined" &&
    (window as unknown as { isElectron?: boolean }).isElectron === true
  );
}

/**
 * `/results/<token>` is a bearer-credential URL — the token IS the auth. We
 * already redact it out of event properties (`scrubSensitiveUrl`), but a
 * replay of that page would capture the address bar's contents in the DOM
 * snapshot regardless. Don't record there at all, at any level.
 */
export function isCredentialBearingPath(
  pathname: string | undefined = typeof window === "undefined"
    ? undefined
    : window.location?.pathname,
): boolean {
  return (
    !!pathname &&
    (pathname.startsWith("/results/") ||
      pathname.startsWith("/conformance/shared/") ||
      pathname.startsWith("/evals/shared/"))
  );
}

export type RecordingSurface = "off" | "desktop" | "hosted";

/** Where this session runs, as far as recording is concerned. */
export function recordingSurface(): RecordingSurface {
  if (
    !isErrorCaptureSurface() ||
    import.meta.env.VITE_DISABLE_POSTHOG_LOCAL === "true"
  ) {
    return "off";
  }
  return HOSTED_MODE ? "hosted" : "desktop";
}

export interface SessionPrivacyInputs {
  surface: RecordingSurface;
  /**
   * A share-link page (a published study's tester chat) that shows a project
   * the viewer may not belong to, so its organization's posture is unknown.
   */
  sharedLink: boolean;
  /**
   * The backend's recording level for the contexts in view, for the current
   * actor (`useTelemetryPrivacyContext`). `undefined` = not answered yet.
   * Anything the backend could not verify — no context in view, no access,
   * no authentication — already arrives as `masked`.
   */
  recording: TelemetryRecording | undefined;
}

/**
 * The level for this session. Pure: the caller supplies the facts.
 *
 * - npx/Docker and dev builds: `off`.
 * - Packaged desktop: `masked` for everyone. It records people debugging their
 *   own MCP servers on their own machines, which is the npx reasoning with
 *   replay kept for crash debugging.
 * - Hosted share links: `masked` — whose data it is cannot be known here.
 * - Hosted otherwise: the backend's answer, `pending` until it arrives. Only a
 *   verified non-private context gets `full`; visitors with no session, and
 *   pages with nothing in view, are `masked`.
 */
export function resolveSessionPrivacy(
  inputs: SessionPrivacyInputs,
): SessionPrivacy {
  if (inputs.surface === "off") return "off";
  if (inputs.surface === "desktop") return "masked";
  if (inputs.sharedLink) return "masked";
  if (inputs.recording === undefined) return "pending";
  return inputs.recording === "full" ? "full" : "masked";
}

// ── The level in effect ────────────────────────────────────────────────

let sessionPrivacy: SessionPrivacy | undefined;

/** The level in effect. Before anything is resolved: `pending`, or `off`. */
export function currentSessionPrivacy(): SessionPrivacy {
  return sessionPrivacy ?? (recordingSurface() === "off" ? "off" : "pending");
}

/** Set by `useSessionPrivacy` only. The recorders read it when synced. */
export function setSessionPrivacy(level: SessionPrivacy): void {
  sessionPrivacy = level;
}

/**
 * Whether analytics must keep names out right now: on a recording surface,
 * anything short of a resolved `full`. `off` surfaces keep today's analytics.
 */
export function shouldMaskAnalytics(): boolean {
  const privacy = currentSessionPrivacy();
  return privacy === "masked" || privacy === "pending";
}

// ── PostHog profiles ───────────────────────────────────────────────────

/**
 * Replay masking at `full`.
 *
 * `maskAllInputs` covers every `<input>`. The inspector also renders secrets
 * as TEXT — OAuth access/refresh tokens in the flow logger, the one-time API
 * key reveal, the SDK quickstart snippet — which no input-level masking can
 * reach. Those already carry this repo's `ph-no-capture rr-block` +
 * `data-ph-no-capture` convention for autocapture, so `maskTextSelector`
 * points at the SAME attribute rather than introducing a second thing to
 * remember: annotate a credential surface once and it is opted out of
 * autocapture AND masked in replay.
 */
export const SECRET_SURFACE_ATTRIBUTE = "data-ph-no-capture";

export const SESSION_RECORDING_OPTIONS = {
  maskAllInputs: true,
  maskInputOptions: { password: true },
  maskTextSelector: `[${SECRET_SURFACE_ATTRIBUTE}]`,
} as const;

/**
 * Media rrweb would otherwise copy into the replay. Blocked at `masked`. The
 * relay blocks the same tags (`MASKED_REPLAY_BLOCKED_TAGS`) in restricted
 * replays it receives.
 */
export const MASKED_BLOCK_SELECTOR = [...MASKED_REPLAY_BLOCKED_TAGS]
  .map((tag) => (tag === "image" ? "svg image" : tag))
  .join(", ");

/**
 * posthog-js routes BOTH the recorded page URL (rrweb meta and URL-change
 * events) and every captured network request through this callback. At
 * `masked`: names scrubbed from the URL, headers and bodies dropped.
 */
export function maskReplayRequest<T extends { name?: string; url?: string }>(
  request: T,
): T {
  return {
    ...request,
    ...(typeof request.name === "string"
      ? { name: scrubNamesFromUrl(request.name) }
      : {}),
    ...(typeof request.url === "string"
      ? { url: scrubNamesFromUrl(request.url) }
      : {}),
    requestHeaders: undefined,
    responseHeaders: undefined,
    requestBody: undefined,
    responseBody: undefined,
  };
}

export const MASKED_SESSION_RECORDING_OPTIONS = {
  maskAllInputs: true,
  maskInputOptions: { password: true },
  // `*` masks every text node; rrweb leaves `<style>` text alone.
  maskTextSelector: "*",
  blockSelector: MASKED_BLOCK_SELECTOR,
  maskAttributeFn: maskReplayAttribute,
  // `false` wins over the project's remote network settings.
  recordHeaders: false,
  recordBody: false,
  captureCanvas: { recordCanvas: false },
  captureJsonLd: false,
  recordCrossOriginIframes: false,
  maskCapturedNetworkRequestFn: maskReplayRequest,
} as const;

export type PostHogProfile = "full" | "masked";

/**
 * Everything posthog-js reads for one profile, as a `set_config` argument.
 * Replay options are read when the recorder starts, so changing profile
 * means stop, `set_config`, start. Autocapture reads its two flags per event.
 */
export function posthogPrivacyConfig(
  profile: PostHogProfile,
): Record<string, unknown> {
  return profile === "masked"
    ? {
        session_recording: MASKED_SESSION_RECORDING_OPTIONS,
        enable_recording_console_log: false,
        mask_all_text: true,
        mask_all_element_attributes: true,
      }
    : {
        session_recording: SESSION_RECORDING_OPTIONS,
        // `null`, not `undefined` (posthog-js skips undefined in set_config):
        // console capture follows the project setting, as it always has.
        enable_recording_console_log: null,
        mask_all_text: false,
        mask_all_element_attributes: false,
      };
}

/** The posthog-js surface this module drives. Every method may be missing. */
export interface PostHogRecorder {
  startSessionRecording?: () => void;
  stopSessionRecording?: () => void;
  set_config?(config: Record<string, unknown>): void;
}

let posthogProfile: PostHogProfile | null = null;
let posthogRecording = false;

/**
 * Bring PostHog in line with the level in effect and the current path.
 *
 * Recording is OFF at init on every surface (`options.disable_session_recording`)
 * and only this function starts it, so there is one way in. A profile change
 * stops the recorder FIRST, then reconfigures, then starts again: nothing
 * past the stop records under the old profile, and the restart takes a fresh,
 * fully masked snapshot. The caller (`useSessionPrivacy`) runs this in a
 * layout effect, before rrweb sees the DOM the new level is for.
 *
 * `startSessionRecording()` without an override still honours the project's
 * sampling, so starting again after a stop never records a session sampling
 * declined. `pending` and credential paths hold the recorder stopped.
 *
 * Never throws — this is a privacy guard on a render path, and posthog-js may
 * be ad-blocked or uninitialized.
 */
export function syncSessionRecording(
  client: PostHogRecorder,
  pathname: string,
): void {
  try {
    const privacy = currentSessionPrivacy();
    if (privacy === "off") return;
    // Analytics masking follows the level even while replay is held off:
    // `pending` analytics are masked.
    const profile: PostHogProfile = privacy === "full" ? "full" : "masked";
    if (profile !== posthogProfile) {
      if (posthogRecording) {
        client.stopSessionRecording?.();
        posthogRecording = false;
      }
      client.set_config?.(posthogPrivacyConfig(profile));
      posthogProfile = profile;
    }
    const shouldRecord =
      privacy !== "pending" && !isCredentialBearingPath(pathname);
    if (shouldRecord && !posthogRecording) {
      client.startSessionRecording?.();
      posthogRecording = true;
    } else if (!shouldRecord && posthogRecording) {
      client.stopSessionRecording?.();
      posthogRecording = false;
    }
  } catch {
    // A failed guard must not break the render. Recording stays as-is.
  }
}

// ── Sentry Replay ──────────────────────────────────────────────────────

interface ReplayFrame {
  data?: { tag?: string; payload?: object };
}

/**
 * Sentry's `beforeAddRecordingEvent`. Sentry Replay masks text, inputs and
 * media at every level (`SENTRY_REPLAY_OPTIONS`); short of `full` this also
 * drops console breadcrumbs and scrubs the URLs in navigation and network
 * frames. Only Sentry's own frames come through here — rrweb's DOM events
 * cannot be edited, which is why the DOM masking is on everywhere.
 */
export function filterSentryReplayFrame<T extends ReplayFrame>(
  frame: T,
): T | null {
  if (!shouldMaskAnalytics()) return frame;
  const data = frame?.data;
  const payload = data?.payload as Record<string, unknown> | undefined;
  if (!data || !payload) return frame;
  if (data.tag === "breadcrumb" && payload.category === "console") {
    return null;
  }
  if (data.tag === "breadcrumb" && payload.category === "navigation") {
    const detail = (payload.data ?? {}) as Record<string, unknown>;
    return {
      ...frame,
      data: {
        ...data,
        payload: {
          ...payload,
          data: {
            ...detail,
            ...(typeof detail.from === "string"
              ? { from: scrubNamesFromUrl(detail.from) }
              : {}),
            ...(typeof detail.to === "string"
              ? { to: scrubNamesFromUrl(detail.to) }
              : {}),
          },
        },
      },
    };
  }
  if (
    data.tag === "performanceSpan" &&
    typeof payload.description === "string"
  ) {
    return {
      ...frame,
      data: {
        ...data,
        payload: {
          ...payload,
          description: scrubNamesFromUrl(payload.description),
        },
      },
    };
  }
  return frame;
}

interface SentryBreadcrumb {
  category?: string;
  data?: Record<string, unknown>;
}

const URL_BREADCRUMB_FIELDS: Record<string, readonly string[]> = {
  navigation: ["from", "to"],
  fetch: ["url"],
  xhr: ["url"],
};

/**
 * Sentry's `beforeBreadcrumb`. Short of `full`, a breadcrumb recorded now
 * keeps no console output and no names in the URLs it carries: error events
 * attach breadcrumbs wholesale, so this is the console and network content
 * of an error event, the counterpart of `filterSentryReplayFrame` for the
 * replay. Decided when the breadcrumb is recorded, so a later, laxer page
 * never relaxes it.
 */
export function filterSentryBreadcrumb<T extends SentryBreadcrumb>(
  breadcrumb: T,
): T | null {
  if (!shouldMaskAnalytics()) return breadcrumb;
  if (breadcrumb?.category === "console") return null;
  const fields = URL_BREADCRUMB_FIELDS[breadcrumb?.category ?? ""];
  if (!fields || !breadcrumb.data) return breadcrumb;
  const data = { ...breadcrumb.data };
  for (const field of fields) {
    if (typeof data[field] === "string") {
      data[field] = scrubNamesFromUrl(data[field] as string);
    }
  }
  return { ...breadcrumb, data };
}

/**
 * `Sentry.replayIntegration` options, explicit rather than inherited from
 * defaults that could move: text, inputs and media masked, and no request or
 * response detail for any URL.
 */
export const SENTRY_REPLAY_OPTIONS = {
  maskAllText: true,
  maskAllInputs: true,
  blockAllMedia: true,
  maskAttributes: [
    "title",
    "placeholder",
    "aria-label",
    "aria-description",
    "alt",
    "action",
    "formaction",
    "poster",
  ],
  // rrweb never passes `href`, `src` or `style` through attribute masking —
  // it rewrites their URLs to absolute ones instead — so elements whose job
  // is a URL, or whose inline style holds one (an MCP server's icon drawn as
  // a CSS mask) or a string (a custom property's label, a brand font), are
  // blocked: kept as sized boxes, their URL and content dropped. Their text
  // is masked at every level anyway, and Sentry's DOM events cannot be
  // edited per level, so this applies at `full` too.
  block: [
    "a[href]",
    "area[href]",
    "iframe",
    "source",
    "track",
    '[style*="url(" i]',
    '[style*="image-set(" i]',
    `[style*='"']`,
    `[style*="'"]`,
  ],
  networkDetailAllowUrls: [] as string[],
  networkCaptureBodies: false,
  beforeAddRecordingEvent: filterSentryReplayFrame,
};
