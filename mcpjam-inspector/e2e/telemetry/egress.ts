/**
 * The telemetry egress proof, shared by the jsdom harness
 * (`client/src/__tests__/telemetry-egress/`) and the real-browser one
 * (`e2e/telemetry/telemetry-egress.browser.ts`).
 *
 * The unit tests for `shared/credential-urls.ts` prove that each scrubber
 * removes a secret from a value handed to it. They cannot prove that every
 * value LEAVING the browser was handed to one: the SDKs build their payloads
 * from the page — the address bar, the DOM, console output, network entries —
 * and compress them before any hook of ours sees the bytes. This module is the
 * other half. It takes what the network actually carried, decodes it all the
 * way down, and looks for a planted secret anywhere in it.
 *
 * So the rules here are about not fooling ourselves:
 *
 *  - Every corpus URL carries a UNIQUE sentinel at the position of its secret,
 *    and every sentinel shares one stem. The scan looks for the stem, case
 *    insensitively, in the request URL, its headers, the raw body and every
 *    decoded layer — a secret that survives truncated, lower-cased or nested
 *    is still found.
 *  - Decoding is total or it fails. A body or a gzipped field that cannot be
 *    decoded is reported as a failure, never skipped: an undecodable payload
 *    is one the scan could not look inside, and a scan that skipped it would
 *    pass for exactly the payload most likely to hide something.
 *  - A clean result proves nothing on its own. The callers also assert that
 *    the expected events ARRIVED (a pageview or custom event, an autocapture
 *    click, an exception, a replay full snapshot, a Sentry replay segment), so
 *    a harness that captured nothing fails instead of passing vacuously.
 *
 * Pure Node (`node:zlib`, `Buffer`): both harnesses decode on the Node side,
 * vitest because jsdom runs in Node, Playwright because `page.route` hands the
 * test process the bytes.
 */
import { gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import {
  CREDENTIAL_ROUTES,
  type CredentialRouteId,
} from "../../shared/credential-urls";

// ── The corpus ─────────────────────────────────────────────────────────

/**
 * The stem every sentinel starts with. Mixed-case and digit-bearing so it
 * cannot occur by accident in a bundle, a stack trace or a base64 blob, and
 * short enough that a truncated value still carries it.
 */
export const SENTINEL_STEM = "SNTLq7Zx";

/** A unique sentinel for one corpus entry. Letters only after the stem. */
export function sentinel(id: string): string {
  return `${SENTINEL_STEM}${id.replace(/[^a-z]/gi, "")}`;
}

/**
 * One URL per registered credential route, the sentinel where the secret
 * goes. Typed against the registry's id union, so a route added to
 * `CREDENTIAL_ROUTES` without a line here is a compile error in this file,
 * and `assertCorpusComplete` fails the run for good measure. Same shapes as
 * `shared/__tests__/credential-urls.test.ts`, relative so the harnesses can
 * navigate to the page routes on their own origin.
 */
export const EGRESS_CORPUS = {
  "score-results": `/results/${sentinel("score")}`,
  "bench-results": `/bench/results/${sentinel("bench")}`,
  "conformance-shared": `/conformance/shared/${sentinel("conf")}`,
  "evals-shared": `/evals/shared/${sentinel("evals")}?tab=summary`,
  "tester-link": `/user-testing/acme-study/${sentinel("tester")}`,
  "tester-link-legacy": `/chatbox/acme-study/${sentinel("chatbox")}`,
  "server-connection-claim": `/connect/server/${sentinel("handoff")}`,
  "mcp-oauth-callback": `/oauth/callback?code=${sentinel("code")}&state=${sentinel("state")}`,
  "github-install-callback": `/settings/integrations/github/callback?code=${sentinel("gh")}&installation_id=42`,
  "workos-callback": `/callback?code=${sentinel("workos")}`,
  "local-access-link": `/#token=${sentinel("access")}&tab=servers`,
  "api-score-run": `/api/web/score/runs/${sentinel("apiscore")}`,
  "api-bench-results": `/api/web/bench/results/${sentinel("apibench")}`,
  "api-conformance-shared": `/api/web/conformance-shared/${sentinel("apiconf")}`,
  "api-session-token-query": `/api/mcp/servers/rpc/stream?serverId=a&_token=${sentinel("session")}`,
  "signed-artifact-link": `https://rt-http.mcpjam.com/artifact?t=${sentinel("artifact")}`,
} as const satisfies Record<CredentialRouteId, string>;

/** Throws when a registered route has no corpus line (or the corpus has a stray one). */
export function assertCorpusComplete(): void {
  const registered = CREDENTIAL_ROUTES.map((route) => route.id).sort();
  const covered = Object.keys(EGRESS_CORPUS).sort();
  if (JSON.stringify(registered) !== JSON.stringify(covered)) {
    throw new Error(
      `egress corpus out of date: registry ${registered.join(",")} vs corpus ${covered.join(",")}`,
    );
  }
}

/** Corpus entries a browser navigates to (the registry's `page` scope). */
export function pageCorpus(): Array<[CredentialRouteId, string]> {
  return CREDENTIAL_ROUTES.filter((route) => route.scope === "page").map(
    (route) => [route.id, EGRESS_CORPUS[route.id]],
  );
}

/** Corpus entries the app fetches (the registry's `api` scope). */
export function apiCorpus(): Array<[CredentialRouteId, string]> {
  return CREDENTIAL_ROUTES.filter((route) => route.scope === "api").map(
    (route) => [route.id, EGRESS_CORPUS[route.id]],
  );
}

/**
 * Credential shapes the registry handles generically rather than by route.
 * Rendered as share links and fetched by the app, so the scrubbers' generic
 * paths (presigned URLs, OAuth token endpoints) are exercised end to end too.
 */
export const GENERIC_EGRESS_URLS = [
  `https://bucket.s3.amazonaws.com/o?X-Amz-Signature=${sentinel("amz")}&X-Amz-Credential=${sentinel("amzc")}`,
  `https://provider.example.com/token?client_secret=${sentinel("cs")}&refresh_token=${sentinel("rt")}`,
] as const;

/**
 * Credential URLs only a page shows, never fetches (`fetch` refuses a URL
 * with userinfo): the shapes a selector cannot match but the URL scrubber
 * must — userinfo, a percent-encoded route segment, an unregistered
 * `*_token` key. Rendered as share links, so they reach both recorders as
 * text, `href` and `src`.
 */
export const LINK_ONLY_EGRESS_URLS = [
  `https://user:${sentinel("userinfo")}@example.com/path`,
  `https://app.mcpjam.com/%72esults/${sentinel("encseg")}`,
  `https://example.com/path?x_vendor_access_token=${sentinel("vendortok")}`,
] as const;

/**
 * Credentials in telemetry strings that are not absolute URLs: a relative URL
 * with a percent-encoded secret key, and a protocol-relative URL with
 * userinfo inside prose.
 */
export const RELATIVE_URL_EGRESS = {
  encodedKey: `/api/test?co%64e=${sentinel("enckey")}`,
  protocolRelative: `failed //user:${sentinel("protorel")}@example.com/path`,
} as const;

// ── Vendor fixtures ────────────────────────────────────────────────────

/** The project key posthog-js is initialised with (`PosthogUtils.ts`). */
export const POSTHOG_TOKEN = "phc_dTOPniyUNU2kD8Jx8yHMXSqiZHM8I91uWopTMX6EBE9";

/**
 * The remote config the stubbed PostHog answers with: everything the project
 * could turn on, turned on — replay, console logs, network timing, request
 * headers AND bodies, no masking, autocapture, exception autocapture. Our
 * client config sets each of these explicitly where it must (`recordHeaders:
 * false`, `recordBody: false`, the masking callbacks), so a run against this
 * config proves the client side wins over a dashboard toggle, not merely that
 * the dashboard happened to be conservative.
 */
export const POSTHOG_REMOTE_CONFIG = {
  supportedCompression: ["gzip", "gzip-js"],
  autocapture_opt_out: false,
  capturePerformance: { network_timing: true, web_vitals: false },
  autocaptureExceptions: true,
  errorTracking: { autocaptureExceptions: true },
  captureDeadClicks: true,
  heatmaps: true,
  elementsChainAsString: true,
  hasFeatureFlags: false,
  surveys: false,
  productTours: false,
  isAuthenticated: false,
  siteApps: [],
  toolbarParams: {},
  toolbarVersion: "toolbar",
  sessionRecording: {
    endpoint: "/s/",
    consoleLogRecordingEnabled: true,
    recorderVersion: "v2",
    sampleRate: null,
    minimumDurationMilliseconds: 0,
    linkedFlag: null,
    networkPayloadCapture: { recordHeaders: true, recordBody: true },
    masking: { maskAllInputs: false, maskTextSelector: null },
    urlTriggers: [],
    urlBlocklist: [],
    eventTriggers: [],
    scriptConfig: { script: "posthog-recorder" },
  },
} as const;

/**
 * `/array/<token>/config.js`, the script posthog-js loads its remote config
 * from (the JSON `/config` endpoint is only its fallback). Exactly what the
 * real endpoint does: assign the config to `window._POSTHOG_REMOTE_CONFIG`.
 */
export function posthogRemoteConfigScript(token = POSTHOG_TOKEN): string {
  return `(window._POSTHOG_REMOTE_CONFIG = window._POSTHOG_REMOTE_CONFIG || {})[${JSON.stringify(
    token,
  )}] = { config: ${JSON.stringify(POSTHOG_REMOTE_CONFIG)}, siteApps: [] };`;
}

// ── Captured requests ──────────────────────────────────────────────────

/** One outbound request, as either harness recorded it. */
export interface CapturedRequest {
  url: string;
  method: string;
  /** How it left: fetch, XHR, sendBeacon, or a `<script src>`. */
  transport: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

export type Sink = "posthog" | "sentry" | "other";

/** PostHog goes through the same-origin relay; Sentry straight to ingest. */
export function sinkOf(url: string): Sink {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "other";
  }
  if (/(^|\.)ingest\.([a-z]+\.)?sentry\.io$/i.test(parsed.hostname)) {
    return "sentry";
  }
  if (/^\/(tlm|relay)(\/|$)/.test(parsed.pathname)) return "posthog";
  return "other";
}

// ── Decoding ───────────────────────────────────────────────────────────

/** Thrown when a payload cannot be decoded completely. Never swallowed. */
export class EgressDecodeError extends Error {
  constructor(message: string) {
    super(`telemetry egress decode failed: ${message}`);
    this.name = "EgressDecodeError";
  }
}

const GZIP_MAGIC = [0x1f, 0x8b];

function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
}

/** zlib header: CMF 0x78 and a valid FCHECK. Sentry's replay worker deflates. */
function isZlib(bytes: Uint8Array): boolean {
  return (
    bytes.length > 2 &&
    (bytes[0] & 0x0f) === 8 &&
    ((bytes[0] << 8) | bytes[1]) % 31 === 0
  );
}

function utf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

/**
 * posthog-js ships gzip inside JSON as a latin1 string (`strFromU8(gzip,
 * true)`): `cv: "2024-10"` snapshot data and mutation fields. Any string that
 * starts with the gzip magic in that encoding is one of them.
 */
function isLatin1Gzip(value: string): boolean {
  return value.charCodeAt(0) === 0x1f && value.charCodeAt(1) === 0x8b;
}

function gunzipLatin1(value: string, path: string): unknown {
  let text: string;
  try {
    text = gunzipSync(Buffer.from(value, "latin1")).toString("utf8");
  } catch (error) {
    throw new EgressDecodeError(`gzip field at ${path}: ${String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    // Not every compressed field is JSON in principle; keep the text so it is
    // still scanned.
    return text;
  }
}

/**
 * Replace every gzipped string inside a JSON value by its decoded content,
 * recursively (a decoded snapshot can itself carry compressed fields).
 * Returns how many fields it decoded, so callers can assert that compressed
 * replay data was actually seen and opened.
 */
export function inflateNested(
  value: unknown,
  path = "$",
  counter = { fields: 0 },
): { value: unknown; fields: number } {
  const walk = (node: unknown, at: string): unknown => {
    if (typeof node === "string") {
      if (!isLatin1Gzip(node)) return node;
      counter.fields += 1;
      return walk(gunzipLatin1(node, at), `${at}<gunzip>`);
    }
    if (Array.isArray(node)) {
      return node.map((item, index) => walk(item, `${at}[${index}]`));
    }
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        out[key] = walk(child, `${at}.${key}`);
      }
      return out;
    }
    return node;
  };
  return { value: walk(value, path), fields: counter.fields };
}

export interface DecodedPostHogRequest {
  sink: "posthog";
  url: string;
  /** The JSON body after transport decoding (gzip, `data=`, base64). */
  body: unknown;
  /** The same, with every nested gzip field decoded too. */
  inflated: unknown;
  /** How many nested gzip fields were opened. */
  inflatedFields: number;
}

/**
 * A PostHog request body, whatever posthog-js chose to send: gzip (`/e/`,
 * `/s/` with `compression=gzip-js`), a `data=` form (optionally base64, the
 * beacon fallback), or plain JSON. `null` for a body-less GET.
 */
export function decodePostHogBody(
  url: string,
  bytes: Uint8Array | null,
): { body: unknown; inflated: unknown; inflatedFields: number } | null {
  if (!bytes || bytes.length === 0) return null;
  let text: string;
  if (isGzip(bytes)) {
    try {
      text = gunzipSync(Buffer.from(bytes)).toString("utf8");
    } catch (error) {
      throw new EgressDecodeError(`gzip body of ${url}: ${String(error)}`);
    }
  } else {
    text = utf8(bytes);
  }
  let compression: string | null = null;
  try {
    compression = new URL(url).searchParams.get("compression");
  } catch {
    // keep null
  }
  if (text.startsWith("data=")) {
    const form = new URLSearchParams(text);
    const data = form.get("data") ?? "";
    text =
      compression === "base64"
        ? Buffer.from(data, "base64").toString("utf8")
        : data;
  } else if (compression === "base64") {
    text = Buffer.from(text, "base64").toString("utf8");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new EgressDecodeError(
      `PostHog body of ${url} is not JSON after decoding: ${String(error)} — ${text.slice(0, 80)}`,
    );
  }
  const { value, fields } = inflateNested(body);
  return { body, inflated: value, inflatedFields: fields };
}

export interface EnvelopeItem {
  header: Record<string, unknown>;
  /** Parsed JSON, or for a replay recording `{ segment: header, events }`. */
  payload: unknown;
}

export interface DecodedEnvelope {
  header: Record<string, unknown>;
  items: EnvelopeItem[];
}

function readLine(bytes: Uint8Array, start: number): [string, number] {
  let end = bytes.indexOf(0x0a, start);
  if (end === -1) end = bytes.length;
  return [utf8(bytes.subarray(start, end)), end + 1];
}

function parseJsonOrThrow(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new EgressDecodeError(
      `${what}: ${String(error)} — ${text.slice(0, 80)}`,
    );
  }
}

/**
 * A replay recording item: `{"segment_id":N}\n` then the rrweb events, as a
 * JSON array or — with Sentry's compression worker — deflated bytes.
 */
function decodeReplayRecording(payload: Uint8Array): unknown {
  const newline = payload.indexOf(0x0a);
  if (newline === -1) {
    throw new EgressDecodeError(
      "replay_recording item without a segment header",
    );
  }
  const segment = parseJsonOrThrow(
    utf8(payload.subarray(0, newline)),
    "replay segment header",
  );
  const rest = payload.subarray(newline + 1);
  let text: string;
  if (isGzip(rest)) {
    text = gunzipSync(Buffer.from(rest)).toString("utf8");
  } else if (isZlib(rest)) {
    text = inflateSync(Buffer.from(rest)).toString("utf8");
  } else if (rest[0] === 0x5b /* [ */ || rest[0] === 0x7b /* { */) {
    text = utf8(rest);
  } else {
    try {
      text = inflateRawSync(Buffer.from(rest)).toString("utf8");
    } catch (error) {
      throw new EgressDecodeError(
        `replay_recording payload is neither JSON nor deflate: ${String(error)}`,
      );
    }
  }
  return { segment, events: parseJsonOrThrow(text, "replay recording events") };
}

/**
 * A Sentry envelope: a header line, then items, each an item-header line and
 * a payload that is either `length` bytes or the rest of the line.
 */
export function decodeSentryEnvelope(bytes: Uint8Array): DecodedEnvelope {
  let body = bytes;
  if (isGzip(body)) body = new Uint8Array(gunzipSync(Buffer.from(body)));
  const [headerLine, afterHeader] = readLine(body, 0);
  const header = parseJsonOrThrow(headerLine, "envelope header") as Record<
    string,
    unknown
  >;
  const items: EnvelopeItem[] = [];
  let offset = afterHeader;
  while (offset < body.length) {
    const [itemHeaderLine, afterItemHeader] = readLine(body, offset);
    if (itemHeaderLine.trim() === "") {
      offset = afterItemHeader;
      continue;
    }
    const itemHeader = parseJsonOrThrow(
      itemHeaderLine,
      "envelope item header",
    ) as Record<string, unknown>;
    let payloadBytes: Uint8Array;
    if (typeof itemHeader.length === "number") {
      payloadBytes = body.subarray(
        afterItemHeader,
        afterItemHeader + itemHeader.length,
      );
      offset = afterItemHeader + itemHeader.length;
      // The payload is followed by a newline unless it is the last item.
      if (body[offset] === 0x0a) offset += 1;
    } else {
      let end = body.indexOf(0x0a, afterItemHeader);
      if (end === -1) end = body.length;
      payloadBytes = body.subarray(afterItemHeader, end);
      offset = end + 1;
    }
    const payload =
      itemHeader.type === "replay_recording"
        ? decodeReplayRecording(payloadBytes)
        : parseJsonOrThrow(
            utf8(payloadBytes),
            `envelope ${String(itemHeader.type)} item`,
          );
    items.push({ header: itemHeader, payload });
  }
  return { header, items };
}

// ── Scanning ───────────────────────────────────────────────────────────

/** One place a sentinel was found. Enough to name the sink and the field. */
export interface SentinelHit {
  sink: Sink;
  url: string;
  /** `url`, `header:<name>`, `raw-body`, or a JSON path into the decoded body. */
  where: string;
  excerpt: string;
}

const STEM_PATTERN = new RegExp(SENTINEL_STEM, "i");

function excerptAround(text: string, index: number): string {
  return text.slice(Math.max(0, index - 60), index + 60);
}

/** Whether a string carries a planted sentinel (decoded or not). */
export function containsSentinel(text: string): boolean {
  return STEM_PATTERN.test(text) || STEM_PATTERN.test(safeDecodeUri(text));
}

/** Every string (and key) in a JSON value that contains the stem, by path. */
export function findSentinelPaths(
  value: unknown,
  path = "$",
): Array<{ path: string; excerpt: string }> {
  const hits: Array<{ path: string; excerpt: string }> = [];
  const walk = (node: unknown, at: string) => {
    if (typeof node === "string") {
      const index = node.search(STEM_PATTERN);
      if (index !== -1)
        hits.push({ path: at, excerpt: excerptAround(node, index) });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${at}[${index}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (STEM_PATTERN.test(key)) {
          hits.push({ path: `${at}{key}`, excerpt: key });
        }
        walk(child, `${at}.${key}`);
      }
    }
  };
  walk(value, path);
  return hits;
}

export interface DecodedRequest {
  request: CapturedRequest;
  sink: Sink;
  posthog?: DecodedPostHogRequest;
  sentry?: DecodedEnvelope;
}

/**
 * Decode one request for its sink. Throws `EgressDecodeError` when a PostHog
 * or Sentry body cannot be fully decoded.
 */
export function decodeRequest(request: CapturedRequest): DecodedRequest {
  const sink = sinkOf(request.url);
  if (sink === "posthog") {
    const decoded = decodePostHogBody(request.url, request.body);
    return {
      request,
      sink,
      posthog: decoded
        ? { sink, url: request.url, ...decoded }
        : {
            sink,
            url: request.url,
            body: null,
            inflated: null,
            inflatedFields: 0,
          },
    };
  }
  if (sink === "sentry") {
    return {
      request,
      sink,
      sentry:
        request.body && request.body.length > 0
          ? decodeSentryEnvelope(request.body)
          : { header: {}, items: [] },
    };
  }
  return { request, sink };
}

/**
 * The two headers the scan does not count, and only on the same-origin relay
 * (`/tlm`, `/relay`): `Referer` and `Cookie`. A browser attaches both to any
 * same-origin request — the full page URL, and PostHog's own persistence
 * cookie, which holds the landing URL — so the relay REMOVES them before
 * anything reaches PostHog (`STRIPPED_REQUEST_HEADERS` in
 * `server/routes/relay.ts`, asserted by "strips cookie/host/session-auth/
 * referer headers" in `server/routes/__tests__/relay.test.ts`). These
 * harnesses intercept at the browser, upstream of that strip, so counting
 * them here would report headers PostHog never receives. What the cookie
 * HOLDS is checked on its own, as storage (`browser-harness.ts`,
 * `storageReport`). Sentry is cross-origin: no cookie, and a `Referer` that is
 * the origin alone under the default policy — both ARE scanned.
 */
function isRelayStrippedHeader(sink: Sink, name: string): boolean {
  const header = name.toLowerCase();
  return sink === "posthog" && (header === "referer" || header === "cookie");
}

/**
 * Every sentinel in one decoded request: the URL, header values, every
 * decoded layer, and — as a backstop for anything the decoders did not
 * reach — the raw body as UTF-8 and latin1. A raw-body hit is reported only
 * when no decoded path explains it, so a leak is named by its field.
 */
export function scanRequest(decoded: DecodedRequest): SentinelHit[] {
  const { request, sink } = decoded;
  const hits: SentinelHit[] = [];
  const add = (into: SentinelHit[], where: string, text: string) => {
    const index = text.search(STEM_PATTERN);
    if (index !== -1) {
      into.push({
        sink,
        url: request.url,
        where,
        excerpt: excerptAround(text, index),
      });
    }
  };
  add(hits, "url", safeDecodeUri(request.url));
  for (const [name, value] of Object.entries(request.headers)) {
    if (isRelayStrippedHeader(sink, name)) continue;
    add(hits, `header:${name}`, value);
  }
  const structured =
    decoded.posthog?.inflated ?? (decoded.sentry ? decoded.sentry : undefined);
  const structuredHits: SentinelHit[] = [];
  if (structured !== undefined) {
    for (const hit of findSentinelPaths(structured)) {
      structuredHits.push({
        sink,
        url: request.url,
        where: hit.path,
        excerpt: hit.excerpt,
      });
    }
  }
  hits.push(...structuredHits);
  if (request.body && structuredHits.length === 0) {
    add(hits, "raw-body(utf8)", utf8(request.body));
    add(hits, "raw-body(latin1)", Buffer.from(request.body).toString("latin1"));
  }
  return hits;
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Decode and scan every telemetry request; `other` sinks are not telemetry. */
export function scanAll(requests: readonly CapturedRequest[]): {
  decoded: DecodedRequest[];
  hits: SentinelHit[];
} {
  const decoded = requests
    .filter((request) => sinkOf(request.url) !== "other")
    .map(decodeRequest);
  return { decoded, hits: decoded.flatMap(scanRequest) };
}

/** A readable failure message: every hit, with its sink and payload path. */
export function describeHits(hits: readonly SentinelHit[]): string {
  return hits
    .map(
      (hit) =>
        `[${hit.sink}] ${hit.url.split("?")[0]} @ ${hit.where}: …${hit.excerpt}…`,
    )
    .join("\n");
}

// ── What arrived ───────────────────────────────────────────────────────

export interface PostHogEvent {
  event: string;
  properties: Record<string, unknown>;
}

/** Every PostHog event in the decoded requests (batches flattened). */
export function posthogEvents(
  decoded: readonly DecodedRequest[],
): PostHogEvent[] {
  const out: PostHogEvent[] = [];
  for (const entry of decoded) {
    const body = entry.posthog?.inflated;
    if (!body) continue;
    // `/e/` sends `{ api_key, batch: [...] }`; `/s/` and older paths send
    // the array itself, or a single event.
    const batch = Array.isArray(body)
      ? body
      : Array.isArray((body as { batch?: unknown }).batch)
        ? (body as { batch: unknown[] }).batch
        : [body];
    for (const item of batch) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as PostHogEvent).event === "string"
      ) {
        out.push(item as PostHogEvent);
      }
    }
  }
  return out;
}

/** rrweb event types, as both recorders number them. */
export const RRWEB = {
  DomContentLoaded: 0,
  Load: 1,
  FullSnapshot: 2,
  IncrementalSnapshot: 3,
  Meta: 4,
  Custom: 5,
  Plugin: 6,
} as const;

/** Every rrweb event inside every PostHog `$snapshot`, decoded. */
export function posthogReplayEvents(
  decoded: readonly DecodedRequest[],
): Array<{ type: number; data?: unknown; cv?: string }> {
  return posthogEvents(decoded)
    .filter((event) => event.event === "$snapshot")
    .flatMap((event) => {
      const data = event.properties.$snapshot_data;
      return Array.isArray(data) ? (data as Array<{ type: number }>) : [];
    });
}

/** How many `cv: "2024-10"` events were seen (compressed on the wire). */
export function compressedReplayEventCount(
  decoded: readonly DecodedRequest[],
): number {
  return posthogReplayEvents(decoded).filter((event) => event.cv === "2024-10")
    .length;
}

/** Every item of every Sentry envelope, with its type. */
export function sentryItems(
  decoded: readonly DecodedRequest[],
): Array<{ type: string; payload: unknown; header: Record<string, unknown> }> {
  return decoded.flatMap((entry) =>
    (entry.sentry?.items ?? []).map((item) => ({
      type: String(item.header.type),
      payload: item.payload,
      header: item.header,
    })),
  );
}

/** rrweb events from every Sentry replay segment. */
export function sentryReplayEvents(
  decoded: readonly DecodedRequest[],
): Array<{ type: number; data?: unknown }> {
  return sentryItems(decoded)
    .filter((item) => item.type === "replay_recording")
    .flatMap((item) => {
      const events = (item.payload as { events?: unknown }).events;
      return Array.isArray(events) ? (events as Array<{ type: number }>) : [];
    });
}

/**
 * Every recorded text node in a list of rrweb events: full snapshots and the
 * nodes mutations add. What a replay viewer would show as text.
 */
export function recordedText(events: readonly unknown[]): string {
  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "textContent" && typeof value === "string") parts.push(value);
      else walk(value);
    }
  };
  walk(events);
  return parts.join(" ");
}

/** The text content of every serialized node in an rrweb full snapshot. */
export function snapshotText(node: unknown): string {
  const parts: string[] = [];
  const walk = (current: unknown) => {
    if (!current || typeof current !== "object") return;
    const record = current as { textContent?: unknown; childNodes?: unknown };
    if (typeof record.textContent === "string") parts.push(record.textContent);
    if (Array.isArray(record.childNodes)) record.childNodes.forEach(walk);
  };
  walk(node);
  return parts.join(" ");
}

// ── The two halves of every assertion, shared by both harnesses ────────

/** What must have arrived for a scenario to count as observed. */
export interface Arrivals {
  /** PostHog event names that must appear at least once. */
  posthogEvents?: string[];
  /** A PostHog replay full snapshot (rrweb type 2) must arrive. */
  posthogFullSnapshot?: boolean;
  /** PostHog replay plugin events (`rrweb/console@1`, `rrweb/network@1`). */
  posthogPlugins?: string[];
  /** Sentry envelope item types that must appear (`event`, `transaction`). */
  sentryItems?: string[];
  /** A Sentry replay segment with a full snapshot must arrive. */
  sentryFullSnapshot?: boolean;
}

/**
 * Every expected arrival that did not happen, as readable lines; empty when
 * all arrived. The other half of a clean scan: a harness that captured
 * nothing has nothing to leak, and must fail here instead.
 */
export function missingArrivals(
  decoded: readonly DecodedRequest[],
  wanted: Arrivals,
): string[] {
  const missing: string[] = [];
  const names = new Set(posthogEvents(decoded).map((event) => event.event));
  for (const name of wanted.posthogEvents ?? []) {
    if (!names.has(name)) missing.push(`PostHog event ${name}`);
  }
  const replay = posthogReplayEvents(decoded);
  if (
    wanted.posthogFullSnapshot &&
    !replay.some((event) => event.type === RRWEB.FullSnapshot)
  ) {
    missing.push("a PostHog replay full snapshot");
  }
  for (const plugin of wanted.posthogPlugins ?? []) {
    const seen = replay.some(
      (event) =>
        event.type === RRWEB.Plugin &&
        (event.data as { plugin?: unknown } | undefined)?.plugin === plugin,
    );
    if (!seen) missing.push(`a PostHog replay ${plugin} event`);
  }
  const items = new Set(sentryItems(decoded).map((item) => item.type));
  for (const type of wanted.sentryItems ?? []) {
    if (!items.has(type)) missing.push(`a Sentry ${type}`);
  }
  if (
    wanted.sentryFullSnapshot &&
    !sentryReplayEvents(decoded).some(
      (event) => event.type === RRWEB.FullSnapshot,
    )
  ) {
    missing.push("a Sentry replay segment with a full snapshot");
  }
  return missing;
}

/** Hits per sink, as the multi-line report a failure prints. */
export function leakReport(hits: readonly SentinelHit[]): {
  posthog: string;
  sentry: string;
} {
  return {
    posthog: describeHits(hits.filter((hit) => hit.sink === "posthog")),
    sentry: describeHits(hits.filter((hit) => hit.sink === "sentry")),
  };
}
