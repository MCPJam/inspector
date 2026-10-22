/**
 * What a PostHog replay keeps of a captured network request, and of the page
 * URL it records: the URL, scrubbed, and the request's timing. posthog-js
 * passes both through `maskCapturedNetworkRequestFn`, which the replay
 * profiles in `../session-privacy.ts` set to the maskers here.
 */
import { scrubCredentialUrl } from "../../../../shared/credential-urls";
import { scrubNamesFromUrl } from "../../../../shared/telemetry-privacy";

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

function buildReplayRequestMasker(profile: "full" | "masked") {
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

/**
 * `maskCapturedNetworkRequestFn` at `masked`. posthog-js routes BOTH the
 * recorded page URL (rrweb meta and URL-change events) and every captured
 * network request through this callback: credentials and names scrubbed from
 * the URL, a host that is not ours replaced, and only timing kept.
 */
export const maskReplayRequest = buildReplayRequestMasker("masked");
