/**
 * Redaction middleware for the Meticulous session recorder.
 *
 * Meticulous records every fetch and XHR body, every WebSocket frame and the
 * browser's storage, and masks only password fields by default. The Inspector
 * sends MCP server credentials, OAuth tokens and session bearers over all of
 * those channels, so this masks them before a payload leaves the browser.
 *
 * `client/vite-meticulous-middleware.ts` compiles this file into a classic
 * script that recording builds load right after the recorder tag. The
 * recorder reads `window.METICULOUS_RECORDER_MIDDLEWARE_V1` each time it
 * uploads, and the same script runs at replay, which keeps transformed
 * requests matchable.
 *
 * A hook that throws aborts the upload. That is deliberate: a bug here must
 * lose a recording, never leak one.
 *
 * The shapes below are structural copies of the `@alwaysmeticulous/api` HAR
 * and session types, kept local so no SDK package ships in the client bundle.
 */

type NameValue = { name: string; value: string };
type HarRequest = {
  url: string;
  method: string;
  headers: NameValue[];
  postData?: { mimeType: string; text?: string };
};
type HarResponse = {
  status: number;
  headers: NameValue[];
  content: { mimeType: string; text?: string; encoding?: string };
};
type StorageEntry = { key: string; value: string };
type Cookie = { name: string; value: string };
type WebSocketEvent = { type: unknown; data?: unknown };
type WebSocketConnection = { url: string; events: WebSocketEvent[] };
type IndexedDBStore = { entries: { key?: unknown; value: unknown }[] };

/** Keys whose value is a credential wherever they appear, after `normalizeKey`. */
const SECRET_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "bearertoken",
  "apikey",
  "xapikey",
  "secret",
  "clientsecret",
  "password",
  "codeverifier",
  "privatekey",
]);
/** Keys whose every nested string is a credential: MCP server headers and env. */
const SECRET_CONTAINER_KEYS = new Set(["headers", "env", "secretpatch"]);
/** Form bodies only: an OAuth authorization code. In JSON, `code` is usually an error code. */
const FORM_SECRET_KEYS = new Set(["code"]);
/** PKCE verifiers are stored under this prefix as bare strings, not JSON. */
const VERIFIER_STORAGE_PREFIX = "mcp-verifier-";
const COOKIE_SECRET_NAME = /session|token|auth|secret/i;

const normalizeKey = (key: string) =>
  key.toLowerCase().replace(/[^a-z0-9]/g, "");

function isSecretKey(key: string, extra?: Set<string>): boolean {
  const normalized = normalizeKey(key);
  return SECRET_KEYS.has(normalized) || (extra?.has(normalized) ?? false);
}

/** Same-length asterisks keep JSON shape and any length checks intact at replay. */
export function mask(value: string): string {
  return "*".repeat(value.length);
}

/**
 * Masks every string under a secret key, and every string inside a secret
 * container. Returns the input itself when nothing changed, so untouched
 * payloads are never copied.
 */
export function maskSecrets(value: unknown, insideSecret = false): unknown {
  if (typeof value === "string") return insideSecret ? mask(value) : value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const masked = maskSecrets(item, insideSecret);
      if (masked !== item) changed = true;
      return masked;
    });
    return changed ? out : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const secret =
        insideSecret ||
        isSecretKey(key) ||
        SECRET_CONTAINER_KEYS.has(normalizeKey(key));
      const masked = maskSecrets(child, secret);
      if (masked !== child) changed = true;
      out[key] = masked;
    }
    return changed ? out : value;
  }
  return value;
}

function maskJsonText(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON, so there is no structure to walk; the text is returned as is.
    return text;
  }
  const masked = maskSecrets(parsed);
  return masked === parsed ? text : JSON.stringify(masked);
}

function maskFormText(text: string): string {
  const params = new URLSearchParams(text);
  let changed = false;
  for (const key of Array.from(new Set(params.keys()))) {
    const value = params.get(key);
    if (value && isSecretKey(key, FORM_SECRET_KEYS)) {
      params.set(key, mask(value));
      changed = true;
    }
  }
  return changed ? params.toString() : text;
}

function maskBodyText(
  mimeType: string,
  text: string | undefined,
): string | undefined {
  if (!text) return text;
  const type = mimeType.toLowerCase();
  if (type.includes("json")) return maskJsonText(text);
  if (type.includes("x-www-form-urlencoded")) return maskFormText(text);
  // A `fetch` with a string body and no content type is sent as text/plain
  // but is JSON in practice.
  if (/^\s*[[{]/.test(text)) return maskJsonText(text);
  return text;
}

function maskHeaders(headers: NameValue[]): NameValue[] {
  let changed = false;
  const out = headers.map((header) => {
    if (!header.value || !isSecretKey(header.name)) return header;
    changed = true;
    return { ...header, value: mask(header.value) };
  });
  return changed ? out : headers;
}

function maskUrl(url: string): string {
  if (!url.includes("?")) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A relative or malformed URL has no query the recorder could replay.
    return url;
  }
  let changed = false;
  for (const key of Array.from(new Set(parsed.searchParams.keys()))) {
    const value = parsed.searchParams.get(key);
    if (value && isSecretKey(key)) {
      parsed.searchParams.set(key, mask(value));
      changed = true;
    }
  }
  return changed ? parsed.toString() : url;
}

export function redactRequest<T extends HarRequest>(request: T): T {
  const headers = maskHeaders(request.headers);
  const url = maskUrl(request.url);
  const text = request.postData
    ? maskBodyText(request.postData.mimeType, request.postData.text)
    : undefined;
  const bodyUnchanged = !request.postData || text === request.postData.text;
  if (headers === request.headers && url === request.url && bodyUnchanged) {
    return request;
  }
  return {
    ...request,
    url,
    headers,
    ...(request.postData ? { postData: { ...request.postData, text } } : {}),
  };
}

export function redactResponse<T extends HarResponse>(response: T): T {
  const headers = maskHeaders(response.headers);
  // `encoding` marks base64 binary content, which has no text to walk.
  const text = response.content.encoding
    ? response.content.text
    : maskBodyText(response.content.mimeType, response.content.text);
  if (headers === response.headers && text === response.content.text) {
    return response;
  }
  return { ...response, headers, content: { ...response.content, text } };
}

/** Convex sync frames are JSON text; the authenticate frame carries the session JWT. */
export function redactWebSocket<T extends WebSocketConnection>(
  connection: T,
): T {
  let changed = false;
  const events = connection.events.map((event) => {
    // Binary frames and lifecycle events carry no JSON.
    if (typeof event.data !== "string") return event;
    const data = maskJsonText(event.data);
    if (data === event.data) return event;
    changed = true;
    return { ...event, data };
  });
  return changed ? { ...connection, events } : connection;
}

export function redactStorageEntry<T extends StorageEntry>(entry: T): T {
  const value =
    isSecretKey(entry.key) || entry.key.startsWith(VERIFIER_STORAGE_PREFIX)
      ? mask(entry.value)
      : maskJsonText(entry.value);
  return value === entry.value ? entry : { ...entry, value };
}

export function redactIndexedDB<T extends IndexedDBStore>(store: T): T {
  const entries = maskSecrets(store.entries);
  // `maskSecrets` keeps the array shape it is given; only the leaves change.
  return entries === store.entries
    ? store
    : { ...store, entries: entries as T["entries"] };
}

export function redactCookie<T extends Cookie>(cookie: T): T {
  if (!cookie.value || !COOKIE_SECRET_NAME.test(cookie.name)) return cookie;
  return { ...cookie, value: mask(cookie.value) };
}

export const inspectorRedactionMiddleware = {
  transformNetworkRequest: (request: HarRequest) => redactRequest(request),
  transformNetworkResponse: (response: HarResponse) => redactResponse(response),
  transformWebSocketConnectionData: redactWebSocket,
  transformLocalStorageEntry: redactStorageEntry,
  transformSessionStorageEntry: redactStorageEntry,
  transformIndexedDBEntries: redactIndexedDB,
  transformCookie: redactCookie,
  // Once any network hook is defined, the recorder drops streamed responses
  // that have no hook of their own, which would lose every chat reply.
  transformStreamingFetchResponseData: <T>(entry: T): T => entry,
  transformStreamingXhrResponseData: <T>(entry: T): T => entry,
};

declare global {
  interface Window {
    METICULOUS_RECORDER_MIDDLEWARE_V1?: unknown[];
  }
}

if (typeof window !== "undefined") {
  window.METICULOUS_RECORDER_MIDDLEWARE_V1 = [
    ...(window.METICULOUS_RECORDER_MIDDLEWARE_V1 ?? []),
    inspectorRedactionMiddleware,
  ];
}
