/**
 * Redaction middleware for the Meticulous session recorder.
 *
 * Meticulous records every fetch and XHR body, every WebSocket frame and the
 * browser's storage, and masks only password fields by default. The Inspector
 * sends MCP server credentials, OAuth tokens and session bearers over all of
 * those channels, so this masks them before a payload leaves the browser.
 *
 * `client/vite-meticulous-middleware.ts` bundles this file and its imports
 * into a classic script that recording builds load right after the recorder
 * tag. The recorder reads `window.METICULOUS_RECORDER_MIDDLEWARE_V1` each
 * time it uploads, and the same script runs at replay, which keeps
 * transformed requests matchable.
 *
 * A hook that throws aborts the upload. That is deliberate: a bug here must
 * lose a recording, never leak one.
 *
 * The shapes below are structural copies of the `@alwaysmeticulous/api` HAR
 * and session types, kept local so no SDK package ships in the client bundle.
 */

import {
  FORM_SECRET_KEYS,
  isSecretKey,
  mask,
  maskFormText,
  maskJsonText,
  maskSecrets,
  maskText,
} from "./meticulous-secrets";
import { createStreamRedactor } from "./meticulous-streams";

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

/** PKCE verifiers are stored under this prefix as bare strings, not JSON. */
const VERIFIER_STORAGE_PREFIX = "mcp-verifier-";
const COOKIE_SECRET_NAME = /session|token|auth|secret/i;
/** Lets `URL` parse a relative request URL; stripped again on the way out. */
const RELATIVE_BASE = "http://relative.invalid";

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
  return maskText(text);
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
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(url);
  let parsed: URL;
  try {
    parsed = new URL(url, RELATIVE_BASE);
  } catch {
    // A malformed URL has no query the recorder could replay.
    return url;
  }
  let changed = false;
  for (const key of Array.from(new Set(parsed.searchParams.keys()))) {
    const value = parsed.searchParams.get(key);
    if (value && isSecretKey(key, FORM_SECRET_KEYS)) {
      parsed.searchParams.set(key, mask(value));
      changed = true;
    }
  }
  if (!changed) return url;
  return absolute
    ? parsed.toString()
    : parsed.toString().slice(RELATIVE_BASE.length);
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
  transformStreamingFetchResponseData: createStreamRedactor(),
  transformStreamingXhrResponseData: createStreamRedactor(),
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
