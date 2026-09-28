/**
 * Requests the hosted OAuth debugger makes on a caller's behalf, and what
 * their responses may carry back (MJ-001).
 *
 * The hosted OAuth proxy routes (`/api/web/oauth/proxy`, `/debug/proxy`,
 * `/metadata`) and the hosted Cross-App Access token proxy send one request to
 * an authorization server, a protected resource or an MCP server, and return
 * the answer to the browser that asked. On the way out a request is limited to
 * the two methods an OAuth flow uses and loses the headers that belong to a
 * connection or a browser session. On the way back an answer keeps its status,
 * a bounded status text, the headers the OAuth flows read, and a body only
 * when it is the kind an OAuth flow consumes: JSON, form-encoded, or (for the
 * debugger's MCP requests) an event stream's JSON events. Any other body is
 * reported by its media type and size.
 *
 * Pure. Callers decide when it applies.
 */

import { OAuthProxyError } from "./oauth-proxy.js";
import {
  boundHeaderValue,
  boundStatusText,
  boundText,
  isPlainRecord,
} from "./hosted-upstream-projection.js";

/** The methods an OAuth flow sends. */
const ALLOWED_METHODS: ReadonlySet<string> = new Set(["GET", "POST"]);

/**
 * Request headers that describe a connection, a proxy hop or a browser
 * session rather than the request. They are dropped, whatever their value.
 */
const DROPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "expect",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

const MAX_REQUEST_HEADERS = 64;
const MAX_REQUEST_HEADER_NAME_LENGTH = 128;
const MAX_REQUEST_HEADER_VALUE_LENGTH = 8 * 1024;

/** The response headers the OAuth flows and the debugger read. */
export const HOSTED_OAUTH_RESPONSE_HEADERS: readonly string[] = [
  "content-type",
  "www-authenticate",
  "location",
  "cache-control",
  "retry-after",
  "dpop-nonce",
  "link",
  "mcp-session-id",
  "mcp-protocol-version",
];

/** Upper bound on a returned body, serialized. A larger one is omitted. */
export const MAX_HOSTED_OAUTH_BODY_BYTES = 256 * 1024;

const MAX_MEDIA_TYPE_LENGTH = 128;

/**
 * The method and headers a hosted OAuth proxy request is sent with. A method
 * other than GET or POST, or headers that are not a flat string map within
 * the limits above, is refused as the caller's error (400).
 */
export function prepareHostedOAuthProxyRequest(input: {
  method?: unknown;
  headers?: unknown;
}): { method: "GET" | "POST"; headers: Record<string, string> } {
  const method =
    input.method === undefined || input.method === null
      ? "GET"
      : typeof input.method === "string"
        ? input.method.toUpperCase()
        : "";
  if (!ALLOWED_METHODS.has(method)) {
    throw new OAuthProxyError(400, "Only GET and POST requests are allowed");
  }
  return {
    method: method as "GET" | "POST",
    headers: prepareHostedOAuthRequestHeaders(input.headers),
  };
}

/** The headers half of {@link prepareHostedOAuthProxyRequest}. */
export function prepareHostedOAuthRequestHeaders(
  headers: unknown,
): Record<string, string> {
  if (headers === undefined || headers === null) return {};
  if (!isPlainRecord(headers)) {
    throw new OAuthProxyError(400, "Request headers must be an object");
  }
  const entries = Object.entries(headers);
  if (entries.length > MAX_REQUEST_HEADERS) {
    throw new OAuthProxyError(400, "Too many request headers");
  }
  const prepared: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (
      typeof value !== "string" ||
      name.length === 0 ||
      name.length > MAX_REQUEST_HEADER_NAME_LENGTH ||
      value.length > MAX_REQUEST_HEADER_VALUE_LENGTH
    ) {
      throw new OAuthProxyError(400, "Invalid request header");
    }
    if (DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    prepared[name] = value;
  }
  return prepared;
}

/** `type/subtype`, lowercased, or `undefined`. */
function mediaTypeOf(contentType: unknown): string | undefined {
  if (typeof contentType !== "string") return undefined;
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  return type ? boundText(type, MAX_MEDIA_TYPE_LENGTH) : undefined;
}

function isJsonMediaType(type: string | undefined): boolean {
  return (
    type !== undefined &&
    (type === "application/json" || type.endsWith("+json"))
  );
}

function byteLength(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 0;
  }
}

/** A JSON value re-serialized, when it fits the body cap. */
function reserializeJson(value: unknown): { value: unknown } | undefined {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (serialized === undefined) return undefined;
  if (Buffer.byteLength(serialized, "utf8") > MAX_HOSTED_OAUTH_BODY_BYTES) {
    return undefined;
  }
  return { value: JSON.parse(serialized) as unknown };
}

/**
 * An event stream as the debug proxy parsed it, keeping each event's name,
 * id and JSON data. Event data that is not JSON, and the raw buffer, are
 * dropped.
 */
function projectEventStream(value: unknown): unknown | undefined {
  if (!isPlainRecord(value) || value.transport !== "sse") return undefined;
  const events = Array.isArray(value.events) ? value.events : [];
  const projectedEvents = events.filter(isPlainRecord).map((event) => ({
    ...(typeof event.event === "string"
      ? { event: boundText(event.event, 64) ?? "" }
      : {}),
    ...(typeof event.id === "string" ? { id: boundText(event.id, 256) } : {}),
    ...(event.data !== null && typeof event.data === "object"
      ? { data: event.data }
      : {}),
  }));
  const mcpResponse =
    value.mcpResponse !== null && typeof value.mcpResponse === "object"
      ? value.mcpResponse
      : null;
  return reserializeJson({
    transport: "sse",
    events: projectedEvents,
    isOldTransport: value.isOldTransport === true,
    mcpResponse,
  })?.value;
}

export type HostedOAuthOmittedBody = {
  bodyOmitted: true;
  contentType: string | null;
  bytes: number;
};

/**
 * A response body as a hosted OAuth proxy returns it. `eventStreams` keeps the
 * JSON events of a `text/event-stream` answer the debug proxy parsed.
 */
export function projectHostedOAuthResponseBody(
  body: unknown,
  contentType: unknown,
  options: { eventStreams?: boolean } = {},
): unknown {
  const type = mediaTypeOf(contentType);
  if (isJsonMediaType(type) && typeof body !== "string") {
    const json = reserializeJson(body ?? null);
    if (json) return json.value;
  } else if (
    type === "application/x-www-form-urlencoded" &&
    typeof body === "string"
  ) {
    const form = new URLSearchParams(body).toString();
    if (Buffer.byteLength(form, "utf8") <= MAX_HOSTED_OAUTH_BODY_BYTES) {
      return form;
    }
  } else if (options.eventStreams && type === "text/event-stream") {
    const stream = projectEventStream(body);
    if (stream !== undefined) return stream;
  }
  const omitted: HostedOAuthOmittedBody = {
    bodyOmitted: true,
    contentType: type ?? null,
    bytes:
      isPlainRecord(body) && typeof body.rawBuffer === "string"
        ? byteLength(body.rawBuffer)
        : byteLength(body),
  };
  return omitted;
}

/** The allowlisted response headers, values bounded. */
export function projectHostedOAuthResponseHeaders(
  headers: unknown,
): Record<string, string> {
  const projected: Record<string, string> = {};
  if (!isPlainRecord(headers)) return projected;
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!HOSTED_OAUTH_RESPONSE_HEADERS.includes(key)) continue;
    const bounded = boundHeaderValue(value);
    if (bounded !== undefined) projected[key] = bounded;
  }
  return projected;
}

export type HostedOAuthProxyResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  finalUrl: string;
};

/**
 * An OAuth proxy answer as a hosted route returns it: status, bounded status
 * text, allowlisted headers, the projected body and the URL that answered.
 */
export function projectHostedOAuthProxyResponse(
  result: {
    status: number;
    statusText?: unknown;
    headers?: unknown;
    body?: unknown;
    finalUrl: string;
  },
  options: { eventStreams?: boolean } = {},
): HostedOAuthProxyResponse {
  const contentType = isPlainRecord(result.headers)
    ? Object.entries(result.headers).find(
        ([name]) => name.toLowerCase() === "content-type",
      )?.[1]
    : undefined;
  return {
    status: result.status,
    statusText: boundStatusText(result.statusText),
    headers: projectHostedOAuthResponseHeaders(result.headers),
    body: projectHostedOAuthResponseBody(result.body, contentType, options),
    finalUrl: result.finalUrl,
  };
}

/**
 * An OAuth metadata document as a hosted route returns it: a JSON object,
 * re-serialized, within the body cap. Anything else is refused as the
 * upstream's error (502).
 */
export function projectHostedOAuthMetadata(
  metadata: unknown,
): Record<string, unknown> {
  if (!isPlainRecord(metadata)) {
    throw new OAuthProxyError(502, "OAuth metadata is not a JSON object");
  }
  const json = reserializeJson(metadata);
  if (!json) {
    throw new OAuthProxyError(
      502,
      `OAuth metadata exceeds the ${MAX_HOSTED_OAUTH_BODY_BYTES}-byte cap`,
    );
  }
  return json.value as Record<string, unknown>;
}
