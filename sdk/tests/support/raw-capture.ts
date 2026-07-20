/**
 * Raw wire capture for MCP integration and conformance assertions.
 *
 * The migration plan (mcp-2026-final-phasing.md §18.4) requires wire-compliance
 * assertions to inspect frames BEFORE any SDK normalization: the v2 client
 * consumes and hides wire-only members (`resultType`, the `_meta` envelope,
 * `ttlMs`/`cacheScope` cache hints), so "the object the client returned" is not
 * evidence that the server put a field on the wire. This helper wraps a `fetch`
 * and records each exchange verbatim — request line, headers, raw body text,
 * parsed-but-unnormalized JSON, and SSE event frames — while teeing the response
 * so the real consumer is unaffected.
 *
 * Scope: bounded request/response exchanges and bounded SSE streams (the shape
 * conformance drives). It buffers the full response body to capture it, so it is
 * NOT suitable for wrapping a long-lived `subscriptions/listen` stream — capture
 * those at a different seam.
 *
 * Lives in test support today. Phase 7 promotes the raw-request facility into
 * `sdk/src/mcp-conformance` when the conformance runner needs hostile framing.
 */

/** Fetch-compatible callable. The wrapped fetch is assignable to `typeof fetch`. */
export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface RawSseEvent {
  /** `event:` field, if present. */
  event?: string;
  /** Concatenated `data:` lines (newline-joined), verbatim. */
  data: string;
  /** `id:` field, if present. */
  id?: string;
  /** Parsed `data` payload when it is a single JSON document, else undefined. */
  json?: unknown;
}

export interface RawRequest {
  method: string;
  url: string;
  /** Header names lowercased (per the Fetch `Headers` iteration contract). */
  headers: Record<string, string>;
  bodyText: string;
  /** Parsed request body when JSON, else undefined. */
  json?: unknown;
}

export interface RawResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Full response body as text ("" for a body-less response). */
  bodyText: string;
  /** Parsed body when the payload is a single JSON document, else undefined. */
  json?: unknown;
  /** Parsed SSE frames when `content-type` is `text/event-stream`. */
  sse?: RawSseEvent[];
}

export interface RawExchange {
  request: RawRequest;
  response: RawResponse;
}

export interface CapturingFetch {
  /** Drop-in `fetch` that records every exchange into `exchanges`. */
  fetch: FetchLike;
  /** Exchanges in call order. */
  exchanges: RawExchange[];
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Parse a Server-Sent Events body into its frames without normalizing. Frames
 * are separated by a blank line; within a frame, `event:`/`data:`/`id:` fields
 * accumulate and lines beginning with `:` are comments (ignored). Multiple
 * `data:` lines join with a newline, per the SSE spec.
 */
export function parseSseEvents(body: string): RawSseEvent[] {
  const events: RawSseEvent[] = [];
  // Frames are delimited by a blank line. Normalize CRLF first.
  const frames = body.replace(/\r\n/g, "\n").split(/\n\n+/);
  for (const frame of frames) {
    if (!frame.trim()) continue;
    let event: string | undefined;
    let id: string | undefined;
    const dataLines: string[] = [];
    let sawField = false;
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue; // comment
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      // A single leading space after the colon is stripped, per spec.
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      switch (field) {
        case "event":
          event = value;
          sawField = true;
          break;
        case "data":
          dataLines.push(value);
          sawField = true;
          break;
        case "id":
          id = value;
          sawField = true;
          break;
        default:
          break;
      }
    }
    if (!sawField) continue;
    const data = dataLines.join("\n");
    const parsed = data ? tryJson(data) : undefined;
    events.push({ event, id, data, json: parsed });
  }
  return events;
}

async function captureRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<RawRequest> {
  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;
  const method = (
    init?.method ?? (isRequest ? (input as Request).method : "GET")
  ).toUpperCase();

  const headers = new Headers(isRequest ? (input as Request).headers : undefined);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }

  let bodyText = "";
  if (typeof init?.body === "string") {
    bodyText = init.body;
  } else if (init?.body == null && isRequest) {
    try {
      bodyText = await (input as Request).clone().text();
    } catch {
      bodyText = "";
    }
  }

  const request: RawRequest = {
    method,
    url,
    headers: headersToObject(headers),
    bodyText,
  };
  const parsed = bodyText ? tryJson(bodyText) : undefined;
  if (parsed !== undefined) request.json = parsed;
  return request;
}

async function captureResponse(response: Response): Promise<RawResponse> {
  // Read a clone so the original body stays intact for the real consumer.
  const clone = response.clone();
  const contentType = response.headers.get("content-type") ?? "";
  const bodyText = await clone.text();
  const raw: RawResponse = {
    status: response.status,
    statusText: response.statusText,
    headers: headersToObject(response.headers),
    bodyText,
  };
  if (contentType.includes("text/event-stream")) {
    raw.sse = parseSseEvents(bodyText);
  } else if (bodyText) {
    const parsed = tryJson(bodyText);
    if (parsed !== undefined) raw.json = parsed;
  }
  return raw;
}

/**
 * Wrap a fetch so every exchange is recorded verbatim into `exchanges`. The
 * returned `fetch` is a drop-in replacement (pass it to an SDK transport's
 * `fetch` option); the real caller receives an untouched response.
 */
export function createCapturingFetch(
  underlying: FetchLike = fetch,
): CapturingFetch {
  const exchanges: RawExchange[] = [];
  const wrapped: FetchLike = async (input, init) => {
    const request = await captureRequest(input, init);
    const response = await underlying(input, init);
    const captured = await captureResponse(response);
    exchanges.push({ request, response: captured });
    return response;
  };
  return { fetch: wrapped, exchanges };
}

/**
 * Read a nested field off an unnormalized JSON value. Returns undefined if any
 * segment is absent.
 *
 * `path` is a dot-path string for the common case, OR an explicit key array —
 * use the array form for MCP `_meta` keys, whose names themselves contain dots
 * (e.g. `["result", "_meta", "io.modelcontextprotocol/serverInfo"]`), which a
 * dot-split cannot address.
 */
export function getWireField(
  value: unknown,
  path: string | readonly string[],
): unknown {
  const keys = typeof path === "string" ? path.split(".") : path;
  return keys.reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, value);
}

/** Whether a field is present (and not undefined). See {@link getWireField} for `path`. */
export function hasWireField(
  value: unknown,
  path: string | readonly string[],
): boolean {
  return getWireField(value, path) !== undefined;
}

const REDACTED = "<redacted>";
const SENSITIVE_HEADER_PREFIXES = ["authorization", "cookie", "set-cookie"];

/**
 * A copy of captured headers safe to log: secret-bearing headers are redacted.
 * The raw {@link RawExchange} is never mutated — capture keeps the true values
 * for assertions; only this log view is scrubbed.
 */
export function redactHeadersForLog(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADER_PREFIXES.some((p) =>
      key.toLowerCase().startsWith(p),
    )
      ? REDACTED
      : value;
  }
  return out;
}
