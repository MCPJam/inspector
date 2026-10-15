/**
 * Sentry Replay: the frame filter (`beforeAddRecordingEvent`), the
 * breadcrumb filter (`beforeBreadcrumb`) and the `replayIntegration`
 * options. `syncSentryReplay` in `../sentry.ts` starts and stops it.
 */
import {
  credentialAttributeSelectors,
  scrubCredentialsInText,
  scrubCredentialUrl,
} from "../../../../shared/credential-urls";
import {
  maskReplayText,
  scrubNamesFromUrl,
} from "../../../../shared/telemetry-privacy";
import { shouldMaskAnalytics } from "./level";
import { SECRET_SURFACE_ATTRIBUTE } from "./posthog-replay";

interface ReplayFrame {
  data?: { tag?: string; payload?: object };
}

// One `[attr]` or `[attr="value"]` part of a CSS selector, as Sentry's
// `htmlTreeAsString` writes them (values are not escaped).
const SELECTOR_ATTRIBUTE = /\[[\w:.-]+(?:="[^"]*")?\]/g;
// One `#id` part. Ids can be data: an MCP prompt argument's or elicitation
// field's name (`prompt-arg-${name}`).
const SELECTOR_ID = /#[^\s.#[>:]+/g;

/**
 * A CSS selector from Sentry (`htmlTreeAsString`, web-vitals element names)
 * without its attribute and id parts: `[aria-label="…"]`, `[title="…"]`,
 * `[name="…"]` and `[alt="…"]` carry the page's text, and an id can carry a
 * name. A value holding its own quote defeats the pattern, so the selector
 * is cut at the first part left over.
 */
export function stripSelectorAttributes(selector: string): string {
  const stripped = selector
    .replace(SELECTOR_ATTRIBUTE, "")
    .replace(SELECTOR_ID, "");
  const leftover = stripped.search(/[["]/);
  return leftover === -1 ? stripped : stripped.slice(0, leftover);
}

// What a Sentry Replay click frame's `data.node.attributes` may keep: code,
// not data. `aria-label`, `title`, `alt` and `name` are text; `id` and
// `testId` can be built from a name (`repo-row-${repoFullName}`).
const UI_FRAME_KEPT_ATTRIBUTES = new Set([
  "class",
  "role",
  "disabled",
  "aria-disabled",
  "data-sentry-component",
]);

/** A `ui.*` frame's payload (click, slow or multi click, key down), masked. */
function maskUiFramePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  if (typeof payload.message === "string") {
    out.message = stripSelectorAttributes(payload.message);
  }
  const data = payload.data as Record<string, unknown> | undefined;
  if (data && typeof data === "object") {
    const nextData: Record<string, unknown> = { ...data };
    if (typeof data.url === "string") {
      nextData.url = scrubNamesFromUrl(data.url);
    }
    if (typeof data.route === "string") {
      nextData.route = scrubNamesFromUrl(data.route);
    }
    const node = data.node as Record<string, unknown> | undefined;
    if (node && typeof node === "object") {
      const attributes =
        node.attributes && typeof node.attributes === "object"
          ? Object.fromEntries(
              Object.entries(node.attributes as Record<string, unknown>).map(
                ([key, value]) => [
                  key,
                  UI_FRAME_KEPT_ATTRIBUTES.has(key) ? value : "***",
                ],
              ),
            )
          : node.attributes;
      nextData.node = {
        ...node,
        attributes,
        ...(typeof node.textContent === "string"
          ? { textContent: maskReplayText(node.textContent) }
          : {}),
      };
    }
    out.data = nextData;
  }
  return out;
}

/**
 * Sentry's `beforeAddRecordingEvent`. Sentry Replay masks text, inputs and
 * media at every level (`SENTRY_REPLAY_OPTIONS`) and never records on a
 * credential location. At every level this scrubs credentials out of the
 * URLs in navigation and network frames and out of breadcrumb messages;
 * short of `full` it also drops console breadcrumbs, scrubs names from
 * those URLs, and takes the page's text out of click and key frames (their
 * selector's attribute parts, the node's text-bearing attributes). Only
 * Sentry's own frames come through here; rrweb's DOM events and page
 * metadata are cleaned in Sentry's transport (`sentry-recording-filter.ts`).
 */
export function filterSentryReplayFrame<T extends ReplayFrame>(
  frame: T,
): T | null {
  const maskNames = shouldMaskAnalytics();
  const scrubUrl = maskNames ? scrubNamesFromUrl : scrubCredentialUrl;
  const data = frame?.data;
  const payload = data?.payload as Record<string, unknown> | undefined;
  if (!data || !payload) return frame;
  if (maskNames && data.tag === "breadcrumb" && payload.category === "console") {
    return null;
  }
  if (
    maskNames &&
    data.tag === "breadcrumb" &&
    typeof payload.category === "string" &&
    payload.category.startsWith("ui.")
  ) {
    return {
      ...frame,
      data: { ...data, payload: maskUiFramePayload(payload) },
    };
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
    const message = scrubCredentialsInText(payload.message);
    if (message === payload.message) return frame;
    return {
      ...frame,
      data: { ...data, payload: { ...payload, message } },
    };
  }
  return frame;
}

interface SentryBreadcrumb {
  category?: string;
  message?: string;
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
  // A click or input names its element as a selector (`htmlTreeAsString`),
  // whose attribute parts are the page's text.
  if (
    breadcrumb?.category?.startsWith("ui.") &&
    typeof breadcrumb.message === "string"
  ) {
    const message = stripSelectorAttributes(breadcrumb.message);
    return message === breadcrumb.message
      ? breadcrumb
      : { ...breadcrumb, message };
  }
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

/** Elements whose URL attribute Sentry's rrweb records unmasked. */
export const SENTRY_UNMASKABLE_URL_ELEMENTS = [
  "a[href]",
  "area[href]",
  "iframe",
  "frame[src]",
  "embed[src]",
  "source",
  "track",
  "input[src]",
  "[srcset]",
  "object[data]",
  "table[background]",
  "td[background]",
  "th[background]",
  '[style*="url(" i]',
  '[style*="image-set(" i]',
] as const;

/**
 * `Sentry.replayIntegration` options, explicit rather than inherited from
 * defaults that could move: text, inputs and media masked, no request or
 * response detail for any URL, and every attribute that can hold a URL or
 * text masked where Sentry honours it.
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
    "href",
    "src",
    "srcset",
    "data",
    "value",
  ],
  // rrweb never passes `href`, `src` or `style` through attribute masking —
  // it rewrites their URLs to absolute ones instead — so elements whose job
  // is a URL, or whose inline style holds one (an MCP server's icon drawn as
  // a CSS mask) or a string (a custom property's label, a brand font), are
  // blocked: kept as sized boxes, their URL and content dropped. So is
  // anything under this repo's secret-surface convention (`rr-block`,
  // `data-ph-no-capture`) and any element whose attribute carries a
  // credential URL. Their text is masked at every level anyway, and Sentry's
  // DOM events cannot be edited per level, so this applies at `full` too.
  block: [
    ".rr-block",
    `[${SECRET_SURFACE_ATTRIBUTE}]`,
    ...SENTRY_UNMASKABLE_URL_ELEMENTS,
    `[style*='"']`,
    `[style*="'"]`,
    ...credentialAttributeSelectors(),
  ],
  networkDetailAllowUrls: [] as string[],
  networkCaptureBodies: false,
  beforeAddRecordingEvent: filterSentryReplayFrame,
};
