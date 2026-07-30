/**
 * HTTP-exchange capture for the wire log.
 *
 * The JSON-RPC log (`rpcLogger`) carries message bodies only. From
 * `2026-07-28` the Streamable HTTP transport mirrors routing and cross-check
 * metadata into HTTP *headers* (`Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`,
 * `MCP-Protocol-Version`), so a body-only log cannot explain a
 * `-32020 HeaderMismatch` — the body looks fine and the disagreeing header is
 * invisible. This module captures the header halves of each exchange.
 *
 * Placement: this wrapper must be the INNERMOST fetch so it records the bytes
 * that actually leave — after `wrapFetchForTaskRouting` has injected the
 * SEP-2663 routing headers.
 *
 * Bodies are deliberately NOT captured. The request body is already in the
 * JSON-RPC log, and reading the response body here would consume the stream
 * the transport is about to parse. The one thing derived from the request
 * body is the small set of values the mirrored headers are supposed to equal,
 * so the cross-check can run later without retaining the body.
 */

import {
  TASK_ROUTED_METHODS,
  type MirroredBodyValues,
} from "./mcp-header-mirror.js";

/** `_meta` key carrying the per-request protocol version in the modern era. */
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";

/**
 * Headers whose VALUE never reaches the log. Tracing is a screenshot, export,
 * and agent-snapshot surface, and these carry credentials rather than protocol
 * metadata. The header NAME is kept — knowing an `Authorization` header was
 * present (and with which scheme) is exactly what auth debugging needs.
 *
 * Deliberately NOT `redactHeadersForLog` from the conformance raw harness:
 * that one blanks the whole value (its output feeds golden traces, where a
 * preserved scheme would be one more thing to diff) and it lives in a
 * subsystem this transport path should not import. Same intent, different
 * output contract — keep both, and keep them honest.
 */
const REDACTED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
]);

const REDACTED_PLACEHOLDER = "<redacted>";

function redactHeaderValue(name: string, value: string): string {
  if (!REDACTED_HEADERS.has(name.toLowerCase())) return value;
  // Preserve the auth scheme (`Bearer`, `Basic`, `DPoP`) — it is protocol
  // information, not a secret, and it is the first thing you check.
  const scheme = /^([A-Za-z][A-Za-z0-9-]*)\s+\S/.exec(value)?.[1];
  return scheme ? `${scheme} ${REDACTED_PLACEHOLDER}` : REDACTED_PLACEHOLDER;
}

function collectHeaders(headers: HeadersInit | Headers | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  try {
    new Headers(headers as HeadersInit).forEach((value, key) => {
      out[key] = redactHeaderValue(key, value);
    });
  } catch {
    // A malformed HeadersInit must never fail the request it describes.
  }
  return out;
}

/** Request-body facts the mirrored headers are supposed to agree with. */
export function deriveMirroredBodyValues(
  body: BodyInit | null | undefined
): MirroredBodyValues | undefined {
  if (typeof body !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  // Only a single request mirrors headers; a batch has no single method/name.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const { method, params } = parsed as {
    method?: unknown;
    params?: {
      name?: unknown;
      uri?: unknown;
      taskId?: unknown;
      _meta?: Record<string, unknown>;
    };
  };
  // `params.taskId` is the `Mcp-Name` source for the SEP-2663 routed task
  // methods and for nothing else, so it is read only for those — otherwise a
  // method that merely carries a taskId would be cross-checked against the
  // wrong field.
  const routedTaskId =
    typeof method === "string" && TASK_ROUTED_METHODS.has(method)
      ? params?.taskId
      : undefined;
  const name = params?.name ?? params?.uri ?? routedTaskId;
  const protocolVersion = params?._meta?.[PROTOCOL_VERSION_META_KEY];
  const derived: MirroredBodyValues = {
    method: typeof method === "string" ? method : undefined,
    name: typeof name === "string" ? name : undefined,
    protocolVersion:
      typeof protocolVersion === "string" ? protocolVersion : undefined,
  };
  return derived.method === undefined &&
    derived.name === undefined &&
    derived.protocolVersion === undefined
    ? undefined
    : derived;
}

/** One HTTP exchange, headers only. */
export type HttpExchangeLogEvent = {
  serverId: string;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
  };
  /** Set when the fetch itself rejected (DNS, TLS, abort) — no response. */
  error?: string;
  durationMs: number;
  /** Present only when the request body was a single JSON-RPC request. */
  bodyValues?: MirroredBodyValues;
};

export type HttpExchangeLogger = (event: HttpExchangeLogEvent) => void;

function requestMethodOf(input: Parameters<typeof fetch>[0], init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input === "object" && input !== null && "method" in input) {
    return String((input as Request).method).toUpperCase();
  }
  return "GET";
}

function requestHeadersOf(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit
): HeadersInit | Headers | undefined {
  if (init?.headers) return init.headers;
  if (typeof input === "object" && input !== null && "headers" in input) {
    return (input as Request).headers;
  }
  return undefined;
}

function requestUrlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof input === "object" && input !== null && "url" in input) {
    return String((input as Request).url);
  }
  return String(input);
}

/**
 * Wraps `fetch` so every HTTP exchange is reported to `logger`, headers only.
 *
 * Applies to ALL protocol versions, not just modern: `MCP-Protocol-Version`
 * exists from `2025-06-18`, and `Mcp-Session-Id` / `Last-Event-ID` exist only
 * in the legacy eras — where a missing session id or a failed resume is
 * precisely the bug being chased. Era-specific meaning is applied at render
 * time, not by dropping the capture here.
 *
 * The logger is guarded and the wrapper adds nothing to the request, so a
 * failure to log can never fail the RPC.
 */
export function wrapFetchForHttpLogging(
  serverId: string,
  logger: HttpExchangeLogger,
  fetchFn?: typeof fetch
): typeof fetch {
  const base = fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const startedAt = Date.now();
    const emit = (event: Omit<HttpExchangeLogEvent, "serverId">) => {
      try {
        logger({ serverId, ...event });
      } catch {
        // Logging is a side-effect; it must not surface as an RPC failure.
      }
    };
    // Snapshot the request BEFORE awaiting: `init.headers` may be a live
    // `Headers` the caller reuses across retries.
    const request = {
      method: requestMethodOf(input, init),
      url: requestUrlOf(input),
      headers: collectHeaders(requestHeadersOf(input, init)),
    };
    const bodyValues = deriveMirroredBodyValues(init?.body);

    try {
      const response = await base(input as never, init as never);
      emit({
        request,
        response: {
          status: response.status,
          statusText: response.statusText,
          headers: collectHeaders(response.headers),
        },
        durationMs: Date.now() - startedAt,
        bodyValues,
      });
      return response;
    } catch (error) {
      emit({
        request,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        bodyValues,
      });
      throw error;
    }
  }) as typeof fetch;
}
