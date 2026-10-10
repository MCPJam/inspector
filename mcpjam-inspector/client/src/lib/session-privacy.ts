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
 * Who gets which level is `resolveSessionPrivacy`. The level is applied to
 * BOTH recorders — PostHog here (`syncSessionRecording`), Sentry Replay in
 * `sentry.ts` (`syncSentryReplay`) — from the same module state, so the two
 * cannot disagree. `docs/session-replay-masking.md` has the table.
 *
 * Fail closed. Nothing records until the level is known; an answer that does
 * not arrive becomes `masked` (`useSessionPrivacy`), never `full`.
 */
import { APP_ROUTES } from "./app-routes";
import { HOSTED_MODE } from "./config";

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
   * The WorkOS session. A guest has none: `signed_out` covers both visitors
   * and guests, whose data is their own and who belong to no organization
   * that could ask for privacy.
   */
  account: "loading" | "signed_out" | "signed_in";
  /**
   * A share-link page (a published study's tester chat) that shows a project
   * the viewer may not belong to, so its organization's posture is unknown.
   */
  sharedLink: boolean;
  /** `resolveEnterprisePrivacyInView`; `undefined` = not known yet. */
  enterprisePrivacyInView: boolean | undefined;
}

/**
 * The level for this session. Pure: the caller supplies the facts.
 *
 * - npx/Docker and dev builds: `off`.
 * - Packaged desktop: `masked` for everyone. It records people debugging their
 *   own MCP servers on their own machines, which is the npx reasoning with
 *   replay kept for crash debugging.
 * - Hosted share links: `masked` — whose data it is cannot be known here.
 * - Hosted, signed out (visitors, guests): `full`. Landing pages and a
 *   guest's own sandbox carry no organization's data.
 * - Hosted, signed in: `masked` when any organization in view has enterprise
 *   privacy, `full` when none does, `pending` until that is known.
 */
export function resolveSessionPrivacy(
  inputs: SessionPrivacyInputs,
): SessionPrivacy {
  if (inputs.surface === "off") return "off";
  if (inputs.surface === "desktop") return "masked";
  if (inputs.sharedLink) return "masked";
  if (inputs.account === "loading") return "pending";
  if (inputs.account === "signed_out") return "full";
  if (inputs.enterprisePrivacyInView === undefined) return "pending";
  return inputs.enterprisePrivacyInView ? "masked" : "full";
}

/**
 * The organization fields this module reads. `enterprisePrivacy` is on the
 * organization row `organizations:getMyOrganizations` returns; it switches on
 * when an organization moves to Enterprise and can be set explicitly.
 */
export interface PrivacyOrganization {
  _id: string;
  enterprisePrivacy?: boolean;
}

/**
 * Whether an organization in view (the route's, the active one, the active
 * project's) has enterprise privacy: any one is enough. `undefined` while
 * the list has not loaded or nothing is in view — never a guess.
 */
export function resolveEnterprisePrivacyInView(
  organizations: readonly PrivacyOrganization[] | undefined,
  organizationIdsInView: ReadonlyArray<string | null | undefined>,
): boolean | undefined {
  if (!organizations) return undefined;
  const inView = organizationIdsInView.filter((id): id is string => !!id);
  if (inView.length === 0) return undefined;
  return organizations.some(
    (org) => org.enterprisePrivacy === true && inView.includes(org._id),
  );
}

/**
 * Whether the signed-in person belongs to ANY organization with enterprise
 * privacy. Identity follows membership, not the organization in view,
 * because person properties outlive the page. `undefined` until the list
 * has loaded; `usePostHogIdentify` sends the id alone until this is `false`.
 */
export function resolveEnterprisePrivacyMember(
  organizations: readonly PrivacyOrganization[] | undefined,
): boolean | undefined {
  if (!organizations) return undefined;
  return organizations.some((org) => org.enterprisePrivacy === true);
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

// ── URL scrubbing ──────────────────────────────────────────────────────

const NAME_PLACEHOLDER = "[name]";

/**
 * Path segments that are the app's own vocabulary, read off the route table
 * so a new route needs no edit here. `p` prefixes every project route; the
 * rest are the API prefixes replayed network requests start with.
 */
const ROUTE_SEGMENTS: ReadonlySet<string> = new Set([
  "p",
  "api",
  "web",
  "v1",
  "mcp",
  ...APP_ROUTES.flatMap((route) => route.path.split("/")).filter(
    (segment) => segment && !segment.startsWith(":") && segment !== "*",
  ),
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ids may stay: a document id says which record without saying what it is
 * called. Convex ids (lowercase base32, always with digits in practice),
 * UUIDs and plain numbers.
 */
function isIdLike(value: string): boolean {
  return (
    /^\d+$/.test(value) ||
    UUID.test(value) ||
    (/^[0-9a-z]{25,40}$/.test(value) && /\d/.test(value))
  );
}

function scrubSegment(segment: string): string {
  if (!segment || ROUTE_SEGMENTS.has(segment) || isIdLike(segment)) {
    return segment;
  }
  return NAME_PLACEHOLDER;
}

/**
 * Replace every name-like part of a URL — server names, project slugs, host
 * names, free-form query values — with a placeholder, keeping route words and
 * ids. The fragment is dropped (it can hold anything, OAuth responses
 * included). A value that is not a URL or path is returned unchanged; one
 * that fails to parse becomes the placeholder.
 */
export function scrubNamesFromUrl(value: string): string {
  const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  if (!isAbsolute && !value.startsWith("/")) return value;
  try {
    const url = new URL(value, "http://scrub.invalid");
    const path = url.pathname
      .split("/")
      .map((segment) => scrubSegment(decodeURIComponent(segment)))
      .join("/");
    const query = [...url.searchParams]
      .map(
        ([key, param]) =>
          `${encodeURIComponent(key)}=${
            isIdLike(param) ? encodeURIComponent(param) : NAME_PLACEHOLDER
          }`,
      )
      .join("&");
    return `${isAbsolute ? url.origin : ""}${path}${query ? `?${query}` : ""}`;
  } catch {
    return NAME_PLACEHOLDER;
  }
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

/** Media rrweb would otherwise copy into the replay. Blocked at `masked`. */
export const MASKED_BLOCK_SELECTOR =
  "img, picture, video, audio, canvas, svg image, iframe, object, embed";

/**
 * Attributes a `masked` replay keeps: the ones layout and styling need and
 * that never hold user text. Everything else — `title`, `alt`, `href`, `src`,
 * `placeholder`, `aria-label`, `id`, most `data-*` — is masked.
 * `maskAllElementAttributes` would also mask `class` and `style`, which
 * leaves a replay of unstyled boxes.
 */
const MASKED_REPLAY_KEPT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "class",
  "style",
  "role",
  "type",
  "dir",
  "lang",
  "rel",
  "tabindex",
  "width",
  "height",
  "colspan",
  "rowspan",
  "disabled",
  "checked",
  "selected",
  "hidden",
  "open",
  "viewbox",
  "xmlns",
  "d",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "points",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "transform",
  "opacity",
  "aria-hidden",
  "aria-expanded",
  "aria-selected",
  "aria-checked",
  "aria-disabled",
  "aria-pressed",
  "aria-current",
  "aria-orientation",
  "data-state",
  "data-side",
  "data-align",
  "data-orientation",
  "data-disabled",
  "data-highlighted",
  "data-selected",
  "data-active",
  "data-open",
  "data-slot",
  "data-variant",
  "data-size",
]);

const MASKED_ATTRIBUTE_VALUE = "***";

export function maskReplayAttribute(name: string, value: string): string {
  return MASKED_REPLAY_KEPT_ATTRIBUTES.has(name.toLowerCase())
    ? value
    : MASKED_ATTRIBUTE_VALUE;
}

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
  ],
  networkDetailAllowUrls: [] as string[],
  networkCaptureBodies: false,
  beforeAddRecordingEvent: filterSentryReplayFrame,
};
