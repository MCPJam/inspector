/**
 * Sentry Replay: the frame filter (`beforeAddRecordingEvent`) and the
 * `replayIntegration` options. `syncSentryReplay` in `../sentry.ts` starts
 * and stops it.
 */
import {
  credentialAttributeSelectors,
  scrubCredentialsInText,
  scrubCredentialUrl,
} from "../../../../shared/credential-urls";
import { shouldMaskAnalytics } from "./level";
import { SECRET_SURFACE_ATTRIBUTE } from "./posthog-replay";
import { scrubNamesFromUrl } from "./url-names";

interface ReplayFrame {
  data?: { tag?: string; payload?: object };
}

/**
 * Sentry's `beforeAddRecordingEvent`. Sentry Replay records only at `full`
 * (`syncSentryReplay`), masks text, inputs and media there
 * (`SENTRY_REPLAY_OPTIONS`), and never on a credential location. This scrubs
 * credentials out of the URLs in navigation and network frames at every
 * level, and short of `full` also drops console breadcrumbs and names. Only
 * Sentry's own frames come through here — rrweb's DOM events and page
 * metadata cannot be edited, which is why recording is blocked at capture on
 * credential pages rather than scrubbed afterwards.
 */
export function filterSentryReplayFrame<T extends ReplayFrame>(
  frame: T,
): T | null {
  const maskNames = shouldMaskAnalytics();
  const scrubUrl = maskNames ? scrubNamesFromUrl : scrubCredentialUrl;
  const data = frame?.data;
  const payload = data?.payload as Record<string, unknown> | undefined;
  if (!data || !payload) return frame;
  if (
    maskNames &&
    data.tag === "breadcrumb" &&
    payload.category === "console"
  ) {
    return null;
  }
  if (data.tag === "breadcrumb" && payload.category === "navigation") {
    const detail = (payload.data ?? {}) as Record<string, unknown>;
    const unchanged =
      (typeof detail.from !== "string" ||
        scrubUrl(detail.from) === detail.from) &&
      (typeof detail.to !== "string" || scrubUrl(detail.to) === detail.to);
    if (unchanged) return frame;
    return {
      ...frame,
      data: {
        ...data,
        payload: {
          ...payload,
          data: {
            ...detail,
            ...(typeof detail.from === "string"
              ? { from: scrubUrl(detail.from) }
              : {}),
            ...(typeof detail.to === "string"
              ? { to: scrubUrl(detail.to) }
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
    if (scrubUrl(payload.description) === payload.description) return frame;
    return {
      ...frame,
      data: {
        ...data,
        payload: {
          ...payload,
          description: scrubUrl(payload.description),
        },
      },
    };
  }
  if (data.tag === "breadcrumb" && typeof payload.message === "string") {
    if (scrubCredentialsInText(payload.message) === payload.message) {
      return frame;
    }
    return {
      ...frame,
      data: {
        ...data,
        payload: {
          ...payload,
          message: scrubCredentialsInText(payload.message),
        },
      },
    };
  }
  return frame;
}

/**
 * `Sentry.replayIntegration` options, explicit rather than inherited from
 * defaults that could move: text, inputs and media masked, no request or
 * response detail for any URL, and every attribute that can hold a URL
 * masked where Sentry honours it — Sentry offers no attribute callback, and
 * its rrweb writes `href`/`src`/`srcset`/`data` as they are. An element whose
 * URL attribute carries a credential, and anything under this repo's
 * secret-surface convention (`rr-block`, `data-ph-no-capture`), is therefore
 * blocked outright.
 */
/** Elements whose URL attribute Sentry's rrweb records unmasked. */
export const SENTRY_UNMASKABLE_URL_ELEMENTS = [
  "a[href]",
  "area[href]",
  "iframe[src]",
  "frame[src]",
  "embed[src]",
  "source[src]",
  "source[srcset]",
  "track[src]",
  "input[src]",
  "[srcset]",
  "object[data]",
  "table[background]",
  "td[background]",
  "th[background]",
  '[style*="url("]',
] as const;

export const SENTRY_REPLAY_OPTIONS = {
  maskAllText: true,
  maskAllInputs: true,
  blockAllMedia: true,
  // Sentry's rrweb writes `href`, `src`, `srcset`, `xlink:href`,
  // `background`, `object[data]` and `style` as absolute URLs before any
  // masking hook runs (`transformAttribute`), so no callback can scrub them.
  // Every element carrying one is blocked, whatever its URL holds: matching
  // credential shapes in selectors cannot follow the URL scrubber's semantics
  // (userinfo, percent-encoded segments, any `*_token` key). Text is masked
  // and media blocked here already, so this costs the replay little.
  block: [
    ".rr-block",
    `[${SECRET_SURFACE_ATTRIBUTE}]`,
    ...SENTRY_UNMASKABLE_URL_ELEMENTS,
    ...credentialAttributeSelectors(),
  ],
  maskAttributes: [
    "title",
    "placeholder",
    "aria-label",
    "aria-description",
    "alt",
    "href",
    "src",
    "srcset",
    "action",
    "formaction",
    "poster",
    "data",
    "value",
  ],
  networkDetailAllowUrls: [] as string[],
  networkCaptureBodies: false,
  beforeAddRecordingEvent: filterSentryReplayFrame,
};
