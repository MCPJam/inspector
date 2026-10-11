/**
 * PostHog: the replay profile for each level (maskers and recording
 * options), its `set_config` argument, and `syncSessionRecording`, which
 * starts and stops the recorder.
 */
import {
  scrubCredentialsInText,
  scrubCredentialUrl,
  type LocationLike,
} from "../../../../shared/credential-urls";
import { currentSessionPrivacy, isCredentialBearingPath } from "./level";
import { scrubNamesFromUrl } from "./url-names";

export type PostHogProfile = "full" | "masked";

/**
 * Replay masking at `full`.
 *
 * `maskAllInputs` covers every `<input>`. The inspector also renders secrets
 * as TEXT — OAuth access/refresh tokens in the flow logger, the one-time API
 * key reveal, the SDK quickstart snippet — which no input-level masking can
 * reach. Those already carry this repo's `ph-no-capture rr-block` +
 * `data-ph-no-capture` convention for autocapture, so text under the SAME
 * attribute is masked in replay too: annotate a credential surface once and
 * it is opted out of autocapture AND masked in replay.
 */
export const SECRET_SURFACE_ATTRIBUTE = "data-ph-no-capture";

/** rrweb's own masking: every non-space character becomes `*`. */
function maskAllCharacters(text: string): string {
  return text.replace(/[\S]/g, "*");
}

function isUnderSecretSurface(element: Element | null | undefined): boolean {
  try {
    return !!element?.closest?.(`[${SECRET_SURFACE_ATTRIBUTE}]`);
  } catch {
    return true;
  }
}

/**
 * `maskTextFn` at `full`. rrweb calls it only for text its `maskTextSelector`
 * matches, so the full profile matches every node (`*`) and decides here:
 * text under a secret surface is masked as before, and every other text node
 * keeps its words but loses any credential URL in it — a share link shown on
 * the page is a credential whatever the level.
 */
export function maskReplayTextFull(text: string, element?: Element): string {
  if (isUnderSecretSurface(element)) return maskAllCharacters(text);
  // No pre-check here: the registry runs its own (`/`, `=`, `%` or `:`), and
  // a narrower copy let `encodeURIComponent("/results/<token>")` through.
  return scrubCredentialsInText(text);
}

/** `maskTextFn` at `masked`: every text node, as `maskTextSelector: "*"` did. */
export function maskReplayTextMasked(text: string): string {
  return maskAllCharacters(text);
}

/**
 * `maskAttributeFn` at `full`: attribute values keep their content, minus any
 * credential URL — the Preview iframe's `src`, a share button's `href` or
 * `title`.
 */
export function maskReplayAttributeFull(_name: string, value: string): string {
  return scrubCredentialsInText(value);
}

/**
 * The page URL a replay meta event may carry when nothing else can be shown.
 * posthog-js uses whatever `maskCapturedNetworkRequestFn` returns as the
 * `href`; an empty one breaks the player, so a placeholder stands in.
 */
export const REPLAY_PLACEHOLDER_HREF = "https://redacted.invalid/";

/**
 * The fields of a captured network entry a replay keeps: its URL (scrubbed)
 * and its timing. Everything else is dropped — request and response headers
 * and bodies above all, but also `serverTiming`, which a server can fill with
 * anything. posthog-js uses this callback INSTEAD of its own body scrubber,
 * so nothing it used to scrub may pass through here.
 */
const KEPT_NETWORK_FIELDS = [
  "entryType",
  "initiatorType",
  "method",
  "status",
  "responseStatus",
  "isInitial",
  "startTime",
  "endTime",
  "duration",
  "timeOrigin",
  "timestamp",
  "fetchStart",
  "domainLookupStart",
  "domainLookupEnd",
  "connectStart",
  "secureConnectionStart",
  "connectEnd",
  "requestStart",
  "responseStart",
  "responseEnd",
  "redirectStart",
  "redirectEnd",
  "workerStart",
  "transferSize",
  "encodedBodySize",
  "decodedBodySize",
  "nextHopProtocol",
  "renderBlockingStatus",
  "deliveryType",
] as const;

type CapturedRequest = { name?: string; url?: string } & Record<
  string,
  unknown
>;

function buildReplayRequestMasker(profile: PostHogProfile) {
  const scrubUrl = (url: string) =>
    profile === "masked" ? scrubNamesFromUrl(url) : scrubCredentialUrl(url);
  return function maskRequest<T extends CapturedRequest>(request: T): T | null {
    // posthog-js calls this with `{ name: href }` alone for the page URL of
    // a meta or URL-change event, and with a full entry for network requests.
    const isPageUrl = request.entryType === undefined && !request.isInitial;
    try {
      const out: Record<string, unknown> = {};
      for (const field of KEPT_NETWORK_FIELDS) {
        if (request[field] !== undefined) out[field] = request[field];
      }
      if (typeof request.name === "string") {
        out.name = scrubUrl(request.name);
      }
      if (typeof request.url === "string") out.url = scrubUrl(request.url);
      if (isPageUrl && !out.name) out.name = REPLAY_PLACEHOLDER_HREF;
      return out as T;
    } catch {
      // Cannot show it clean: drop a request, and give a page URL the
      // placeholder (an empty href breaks the player).
      return isPageUrl ? ({ name: REPLAY_PLACEHOLDER_HREF } as T) : null;
    }
  };
}

/** `maskCapturedNetworkRequestFn` at `full`: credentials out of the URL. */
export const maskReplayRequestFull = buildReplayRequestMasker("full");

export const SESSION_RECORDING_OPTIONS = {
  maskAllInputs: true,
  maskInputOptions: { password: true },
  // Every text node goes through `maskTextFn`; see `maskReplayTextFull`.
  maskTextSelector: "*",
  maskTextFn: maskReplayTextFull,
  maskAttributeFn: maskReplayAttributeFull,
  // Explicit at every level: `false` wins over the project's remote network
  // settings, so a dashboard toggle can never widen what is captured.
  recordHeaders: false,
  recordBody: false,
  maskCapturedNetworkRequestFn: maskReplayRequestFull,
  // DOM events reach `before_send` as plain JSON, not gzip strings, so its
  // pass can scrub the stylesheet text rrweb masks nowhere
  // (`scrubCaptureEvent` in lib/PosthogUtils.ts). posthog-js still gzips
  // the request body by default.
  compress_events: false,
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

/**
 * `maskAttributeFn` at `masked`: the kept attributes keep their value (with
 * any credential URL scrubbed — a `style` can carry a `url(…)`), every other
 * attribute is masked.
 */
export function maskReplayAttribute(name: string, value: string): string {
  return MASKED_REPLAY_KEPT_ATTRIBUTES.has(name.toLowerCase())
    ? maskReplayAttributeFull(name, value)
    : MASKED_ATTRIBUTE_VALUE;
}

/**
 * `maskCapturedNetworkRequestFn` at `masked`. posthog-js routes BOTH the
 * recorded page URL (rrweb meta and URL-change events) and every captured
 * network request through this callback: credentials and names scrubbed from
 * the URL, a host that is not ours replaced, and only timing kept.
 */
export const maskReplayRequest = buildReplayRequestMasker("masked");

export const MASKED_SESSION_RECORDING_OPTIONS = {
  maskAllInputs: true,
  maskInputOptions: { password: true },
  // `*` masks every text node; rrweb leaves `<style>` text alone.
  maskTextSelector: "*",
  maskTextFn: maskReplayTextMasked,
  blockSelector: MASKED_BLOCK_SELECTOR,
  maskAttributeFn: maskReplayAttribute,
  // `false` wins over the project's remote network settings.
  recordHeaders: false,
  recordBody: false,
  captureCanvas: { recordCanvas: false },
  captureJsonLd: false,
  recordCrossOriginIframes: false,
  maskCapturedNetworkRequestFn: maskReplayRequest,
  // See SESSION_RECORDING_OPTIONS.
  compress_events: false,
} as const;

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
/** The client `syncSessionRecording` last drove, for the navigation guard. */
let lastPostHogClient: PostHogRecorder | null = null;

/** The PostHog client the recorders were last synced with, if any. */
export function lastSyncedPostHogClient(): PostHogRecorder | null {
  return lastPostHogClient;
}

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
 * declined. `pending` and credential locations (`isCredentialBearingPath`:
 * path, query and fragment) hold the recorder stopped.
 *
 * Never throws — this is a privacy guard on a render path, and posthog-js may
 * be ad-blocked or uninitialized.
 */
export function syncSessionRecording(
  client: PostHogRecorder,
  location: string | LocationLike,
): void {
  lastPostHogClient = client;
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
      privacy !== "pending" && !isCredentialBearingPath(location);
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
