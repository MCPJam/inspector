/**
 * The HTTP layer `probeMcpServer` and its metadata discovery share: one
 * recorded request per `ProbeHttpAttempt`, a timeout per request, bodies read
 * as JSON where they parse, and credentials redacted from the record once the
 * request is done.
 *
 * Browser-safe: `fetch`, `Headers`, `AbortController` only.
 */

import {
  isSensitiveHeaderName,
  redactSensitiveTraceValue,
} from "./oauth/state-machines/trace-redaction.js";
import type { OAuthProtocolVersion } from "./oauth/state-machines/types.js";
import { readSseJsonRpc } from "./directory-readiness/discovery.js";

/** How much of an event stream is read looking for its first message. */
const MAX_EVENT_STREAM_PROBE_BYTES = 64 * 1024;

export interface ProbeHttpAttempt {
  name:
    | "stateless_server_discover"
    | "stateless_tools_list"
    | "streamable_initialize"
    | "sse_probe"
    | "resource_metadata"
    | "authorization_server_metadata";
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  };
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body?: unknown;
    contentType?: string;
  };
  error?: string;
  durationMs: number;
}

export type ParsedHttpResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body?: unknown;
  contentType?: string;
};

export function normalizeProtocolVersion(
  value: OAuthProtocolVersion | undefined
): OAuthProtocolVersion {
  return value ?? "2025-11-25";
}

export function normalizeHeaders(
  headers: Headers | HeadersInit | undefined
): Record<string, string> {
  if (!headers) {
    return {};
  }

  const normalized: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    normalized[key] = value;
  });
  return normalized;
}

function lowerCaseHeaders(
  headers: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
}

function parseJsonBody(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

/** A JSON-RPC request body's id; `undefined` when it has none. */
function jsonRpcRequestId(body: unknown): string | number | undefined {
  if (typeof body !== "object" || body === null || !("id" in body)) {
    return undefined;
  }
  const { id } = body;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

async function readResponseBody(
  response: Response,
  firstEventStreamMessage: boolean,
  requestId: string | number | undefined
): Promise<{ body?: unknown; contentType?: string }> {
  const contentType = response.headers.get("content-type") ?? undefined;
  if (contentType?.includes("text/event-stream")) {
    // A server may hold a stream open, so one is read only when the caller
    // expects an answer on it, and only up to the response to this request.
    if (!firstEventStreamMessage) return { contentType };
    const body = await readSseJsonRpc(
      response,
      MAX_EVENT_STREAM_PROBE_BYTES,
      requestId
    );
    return body === undefined ? { contentType } : { body, contentType };
  }

  const text = await response.text();
  if (!text) {
    return { body: undefined, contentType };
  }

  if (
    contentType?.includes("application/json") ||
    contentType?.includes("+json")
  ) {
    return {
      body: parseJsonBody(text),
      contentType,
    };
  }

  return {
    body: parseJsonBody(text),
    contentType,
  };
}

function withTimeoutSignal(timeoutMs: number | undefined): {
  signal: AbortSignal | undefined;
  cleanup: () => void;
  didTimeout: () => boolean;
} {
  if (!timeoutMs) {
    return {
      signal: undefined,
      cleanup: () => undefined,
      didTimeout: () => false,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const handle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(handle),
    didTimeout: () => timedOut,
  };
}

function createTimeoutError(
  timeoutMs: number | undefined
): Error & { code: string } {
  const error = new Error(
    timeoutMs ? `Request timed out after ${timeoutMs}ms` : "Request timed out"
  ) as Error & { code: string };
  error.name = "TimeoutError";
  error.code = "ETIMEDOUT";
  return error;
}

/**
 * Replace credential values on a recorded attempt with their redacted display
 * form.
 *
 * `attempt.request.headers` is the same object `performRequest` hands to
 * `fetch`, and it ships to the caller inside `transport.attempts`. Redacting it
 * before the dial would break the request, so this runs once the dial is done.
 * The attempt record exists to show the *shape* of the request; the secret
 * value carries no diagnostic weight, and echoing it puts a live token into a
 * JSON body that reaches browser memory, HAR exports and support bundles.
 */
const redactedAttempts = new WeakSet<ProbeHttpAttempt>();

export function redactAttemptCredentials(attempt: ProbeHttpAttempt): void {
  // Runs twice on a dialled attempt — once in `performRequest`, once in the
  // sweep at the end of `probeMcpServer` — so it has to be idempotent. The
  // bookkeeping is out of band because the alternative, recognising an
  // already-redacted value by its text, is decided by the header value: a
  // stored credential containing "[redacted]" would read as already safe and
  // ship verbatim.
  if (redactedAttempts.has(attempt)) {
    return;
  }
  redactedAttempts.add(attempt);

  attempt.request.headers = Object.fromEntries(
    Object.entries(attempt.request.headers).map(([key, value]) =>
      isSensitiveHeaderName(key)
        ? [key, redactSensitiveTraceValue(value)]
        : [key, value]
    )
  );
}

export async function performRequest(
  fetchFn: typeof fetch,
  attempt: ProbeHttpAttempt,
  timeoutMs: number | undefined,
  validateLandingUrl?: (url: string) => void,
  options: {
    /**
     * Read an event-stream answer as far as the response to the request's
     * JSON-RPC id (its first message when the request has no id), as the
     * body. Other streams are left unread.
     */
    firstEventStreamMessage?: boolean;
  } = {}
): Promise<ParsedHttpResponse> {
  const startedAt = Date.now();
  const { signal, cleanup, didTimeout } = withTimeoutSignal(timeoutMs);

  try {
    const response = await fetchFn(attempt.request.url, {
      method: attempt.request.method,
      headers: attempt.request.headers,
      body:
        attempt.request.body === undefined
          ? undefined
          : JSON.stringify(attempt.request.body),
      redirect: "follow",
      signal,
    });

    // Where the response landed, checked before anything is read from it.
    // Refusing to *use* a body fetched from a blocked host is not enough: this
    // attempt is already in the array returned as `transport.attempts`, so
    // recording the response would hand the caller the internal document the
    // guard just rejected. Best-effort — a `fetchFn` that reports no URL leaves
    // nothing to check, which is why the hosted path guards the dial itself.
    if (validateLandingUrl && response.url) {
      validateLandingUrl(response.url);
    }

    const parsedBody = await readResponseBody(
      response,
      options.firstEventStreamMessage === true,
      jsonRpcRequestId(attempt.request.body)
    );
    const normalizedHeaders = normalizeHeaders(response.headers);
    attempt.durationMs = Date.now() - startedAt;
    attempt.response = {
      status: response.status,
      statusText: response.statusText,
      headers: normalizedHeaders,
      body: parsedBody.body,
      contentType: parsedBody.contentType,
    };

    return {
      status: response.status,
      statusText: response.statusText,
      headers: lowerCaseHeaders(normalizedHeaders),
      body: parsedBody.body,
      contentType: parsedBody.contentType,
    };
  } catch (error) {
    const requestError = didTimeout() ? createTimeoutError(timeoutMs) : error;
    attempt.durationMs = Date.now() - startedAt;
    attempt.error =
      requestError instanceof Error
        ? requestError.message
        : String(requestError);
    throw requestError;
  } finally {
    cleanup();
    redactAttemptCredentials(attempt);
  }
}
