/**
 * The single raw-HTTP harness the conformance raw checks drive (Phase 7 §15.5).
 *
 * Every raw check builds its request here and reads the wire back through
 * {@link createCapturingFetch} — status, response headers, verbatim body text,
 * parsed JSON, and parsed SSE frames all come off the SAME capture primitive
 * that `tests/support/raw-capture.ts` re-exports. There is deliberately no
 * second path: an ad-hoc `ctx.fetchFn(...)` + hand-rolled body parse in a check
 * is how the two tracks drift apart.
 *
 * The harness NEVER negotiates and NEVER repairs. It does not run an
 * `initialize` prelude, does not add a protocol-version header of its own, and
 * does not retry: a check that wants any of that asks for it explicitly (see
 * {@link modernEnvelope} / {@link modernHeaders}, which a check opts into). That
 * is what makes it usable for hostile framing — the whole point of the raw
 * track is to send exactly the bytes the check intends, including the wrong
 * ones.
 */

// The reserved `_meta` key names come from the official package rather than
// being retyped here: a hand-copied key that drifts from upstream turns every
// modern probe into a silent false failure (the server sees an unrecognized
// key, not the envelope the check meant to send).
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  LOG_LEVEL_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/client";
import type { RawHttpCheckContext } from "./types.js";
import {
  createCapturingFetch,
  type RawExchange,
  type RawSseEvent,
} from "./raw-capture.js";

export {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  LOG_LEVEL_META_KEY,
  PROTOCOL_VERSION_META_KEY,
};

/** Identity the conformance harness presents to the server under test. */
export const CONFORMANCE_CLIENT_INFO = {
  name: "mcpjam-sdk-conformance",
  version: "1.0.0",
} as const;

/** Protocol version a legacy raw probe pins when the run left it unset. */
export const DEFAULT_LEGACY_PROTOCOL_VERSION = "2025-11-25";

/**
 * Page cap for a raw `tools/list` walk.
 *
 * Matches the official client's default `listMaxPages`, so a server that
 * paginates within what a real client would read is covered in full and one
 * that never stops handing out cursors cannot hang the run.
 *
 * Shared rather than defined per caller: the SEP-2243 declaration CHECK and its
 * readiness sibling scan the same listing for the same faults, and two
 * independent `64`s that must agree is exactly the kind of pair that drifts.
 */
export const MAX_TOOLS_LIST_PAGES = 64;

/** Why a {@link walkToolsList} walk stopped. Only `complete` covered every tool. */
export type ToolsListWalkTermination =
  | "complete"
  | "repeated-cursor"
  | "page-cap";

export type ToolsListWalk = {
  /** Every tool entry read, in page order. Non-object entries are dropped. */
  tools: Array<Record<string, unknown>>;
  termination: ToolsListWalkTermination;
  pagesRead: number;
  /** True when a page came back without a `tools` array (malformed response). */
  malformedPage: boolean;
};

/**
 * Walk a raw `tools/list` to the end, bounded and cycle-safe.
 *
 * Shared by the SEP-2243 declaration CHECK and its readiness sibling: they scan
 * the same listing for the same faults, and two copies of a paginated walk is
 * two places for a cursor bug to live. The caller decides what a truncated walk
 * MEANS — a check cannot claim a pass over tools it never read, while advice
 * simply reports on what it saw — so the reason is returned, not judged here.
 *
 * Cycles are detected against every cursor already issued, not just the
 * previous one: a server that alternates `A → B → A` never repeats
 * back-to-back, so a one-step comparison would re-read the same pages until the
 * cap and report the same offending tool dozens of times.
 */
export async function walkToolsList(options: {
  /** First JSON-RPC id; incremented per page. */
  startId: number;
  /** Per-page request, so callers keep their own probe/observation wrapper. */
  request: (params: {
    id: number;
    cursor: string | undefined;
  }) => Promise<RawHttpResult>;
}): Promise<ToolsListWalk> {
  const tools: Array<Record<string, unknown>> = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let id = options.startId;
  let pagesRead = 0;
  let termination: ToolsListWalkTermination = "page-cap";
  let malformedPage = false;

  for (let page = 0; page < MAX_TOOLS_LIST_PAGES; page += 1) {
    pagesRead = page + 1;
    const result = await options.request({ id: id++, cursor });
    const payload = jsonRpcResult(result);
    const pageTools = payload?.tools;
    if (!Array.isArray(pageTools)) {
      malformedPage = true;
      break;
    }
    for (const entry of pageTools) {
      // Entries come off the wire and can be anything; a non-object one is
      // dropped rather than crashing every caller that reads `.name`.
      if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        tools.push(entry as Record<string, unknown>);
      }
    }

    const next = payload?.nextCursor;
    // Only ABSENT (or empty) means "that was the last page". A non-string
    // `nextCursor` is a malformed response, not an ending — folding the two
    // together would let a check certify a listing it stopped reading early.
    if (next === undefined || next === null || next === "") {
      termination = "complete";
      break;
    }
    if (typeof next !== "string") {
      malformedPage = true;
      break;
    }
    if (seenCursors.has(next)) {
      termination = "repeated-cursor";
      break;
    }
    seenCursors.add(next);
    cursor = next;
  }

  return { tools, termination, pagesRead, malformedPage };
}

export interface RawHttpRequestOptions {
  /** Absolute URL. Defaults to the run's `serverUrl`. */
  url?: string;
  /** HTTP method. Defaults to `POST`. */
  method?: string;
  /**
   * Probe-owned headers. Applied with `Headers.set` AFTER the base headers, so
   * they win by case-insensitive name instead of by object-key order (a plain
   * spread lets a caller's `customHeaders` case-variant concatenate into a
   * probe pin and turn an honest probe into a false failure).
   */
  headers?: Record<string, string>;
  /**
   * Include the run's `customHeaders` + bearer auth. Default `true`. Set
   * `false` for a deliberately unauthenticated / unadorned probe.
   */
  includeBaseHeaders?: boolean;
  /** JSON body; serialized with `JSON.stringify`. Ignored when `rawBody` is set. */
  body?: unknown;
  /** Verbatim request body — for malformed-payload probes. Wins over `body`. */
  rawBody?: string;
  /** Per-request timeout. Defaults to the run's `checkTimeout`. */
  timeoutMs?: number;
  /**
   * Decoding policy for the response body.
   *   - `"auto"` (default): parse JSON when the payload is a single JSON
   *     document, parse SSE frames when `content-type` is `text/event-stream`.
   *   - `"text"`: capture the bytes only; `json`/`sse` stay undefined even if
   *     the payload would parse. Use when the check asserts the exact body.
   */
  decode?: "auto" | "text";
}

export interface RawHttpResult {
  status: number;
  statusText: string;
  /** Response headers, names lowercased. */
  headers: Record<string, string>;
  /** Verbatim response body (partial when `bodyError` is set). */
  bodyText: string;
  /**
   * Why the body could not be read to completion, if it could not. The status
   * line is still authoritative: a check can assert the server ACCEPTED the
   * request while separately reporting that the stream broke.
   */
  bodyError?: string;
  /** Parsed body under the `"auto"` decoding policy, else undefined. */
  json?: unknown;
  /** Parsed SSE frames under the `"auto"` policy for an event-stream body. */
  sse?: RawSseEvent[];
  /** The full captured exchange (request side included). */
  exchange: RawExchange;
}

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

/** Base headers every probe carries unless it opts out: custom headers + auth. */
export function baseHeaders(ctx: RawHttpCheckContext): Record<string, string> {
  return {
    ...(ctx.config.customHeaders ?? {}),
    ...(ctx.config.accessToken
      ? { Authorization: `Bearer ${ctx.config.accessToken}` }
      : {}),
  };
}

/**
 * The full per-request `_meta` envelope the 2026-07-28 wire requires. A
 * conforming modern server rejects an INCOMPLETE envelope before dispatch, so
 * a probe that omits `clientInfo`/`clientCapabilities` never reaches the
 * behavior it meant to test.
 */
export function modernEnvelope(options: {
  protocolVersion: string;
  clientCapabilities?: Record<string, unknown>;
  logLevel?: string;
}): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: options.protocolVersion,
    [CLIENT_INFO_META_KEY]: { ...CONFORMANCE_CLIENT_INFO },
    [CLIENT_CAPABILITIES_META_KEY]: options.clientCapabilities ?? {},
    ...(options.logLevel ? { [LOG_LEVEL_META_KEY]: options.logLevel } : {}),
  };
}

/** A complete modern JSON-RPC request body (envelope included). */
export function modernRequestBody(options: {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  protocolVersion: string;
  clientCapabilities?: Record<string, unknown>;
  logLevel?: string;
}): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: options.id,
    method: options.method,
    params: {
      ...(options.params ?? {}),
      _meta: modernEnvelope(options),
    },
  };
}

/**
 * The SEP-2243 standard request headers for a modern call. `name` is the
 * `Mcp-Name` mirror, required whenever the body carries a `params.name` or
 * `params.uri` (tools/call, prompts/get, resources/read).
 */
export function modernHeaders(options: {
  protocolVersion: string;
  method: string;
  name?: string;
}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": options.protocolVersion,
    "Mcp-Method": options.method,
    ...(options.name === undefined ? {} : { "Mcp-Name": options.name }),
  };
}

/**
 * Headers for a 2025-era raw probe. The session id is a plain header there,
 * so — unlike the modern `Mcp-*` family — a probe can carry or omit it freely.
 */
export function legacyHeaders(options: {
  protocolVersion?: string;
  sessionId?: string;
  accept?: string;
}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: options.accept ?? "application/json, text/event-stream",
    ...(options.protocolVersion
      ? { "mcp-protocol-version": options.protocolVersion }
      : {}),
    ...(options.sessionId ? { "mcp-session-id": options.sessionId } : {}),
  };
}

/**
 * The 2025-era `initialize` prelude a raw legacy probe needs before it can
 * address a stateful server. Returns the exchange verbatim plus the minted
 * session id (absent for a stateless legacy server — that is a legitimate
 * outcome, not an error).
 */
export async function legacyInitialize(
  ctx: RawHttpCheckContext
): Promise<{ result: RawHttpResult; sessionId?: string }> {
  const result = await rawRequest(ctx, {
    headers: legacyHeaders({}),
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion:
          ctx.config.protocolVersion ?? DEFAULT_LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { ...CONFORMANCE_CLIENT_INFO },
      },
    },
  });

  return { result, sessionId: result.headers["mcp-session-id"] };
}

/**
 * Perform one raw exchange and return the wire verbatim. No negotiation, no
 * repair, no retry — see the module docstring.
 */
export async function rawRequest(
  ctx: RawHttpCheckContext,
  options: RawHttpRequestOptions = {}
): Promise<RawHttpResult> {
  const headers = new Headers(
    options.includeBaseHeaders === false ? {} : baseHeaders(ctx)
  );
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers.set(name, value);
  }

  const body =
    options.rawBody ??
    (options.body === undefined ? undefined : JSON.stringify(options.body));

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? ctx.config.checkTimeout
  );

  const capture = createCapturingFetch(ctx.fetchFn);
  try {
    await capture.fetch(options.url ?? ctx.serverUrl, {
      method: options.method ?? "POST",
      headers,
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  const exchange = capture.exchanges[0];
  if (!exchange) {
    throw new Error("Raw HTTP capture recorded no exchange");
  }

  // THE one seam where raw traffic enters the run-wide record. Every raw check
  // in every family builds its requests here, so recording once here covers
  // all of them — and a check added later is covered without touching it.
  ctx.recorder?.recordExchange(exchange);

  const { response } = exchange;
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    bodyText: response.bodyText,
    bodyError: response.bodyError,
    json: options.decode === "text" ? undefined : response.json,
    sse: options.decode === "text" ? undefined : response.sse,
    exchange,
  };
}

/**
 * Observe only the status line and response headers of an exchange, then
 * abort. For probes whose verdict cannot depend on the body: an accepted GET
 * stream legitimately never ends, so `rawRequest` — which reads the body to
 * completion — would always burn its whole timeout on one. The streaming seam
 * (`raw-listen.ts`) is the precedent for fetching outside the capture; this
 * returns no body on purpose so it cannot become a second decode path.
 */
export async function rawHeadersProbe(
  ctx: RawHttpCheckContext,
  options: Pick<
    RawHttpRequestOptions,
    "url" | "method" | "headers" | "timeoutMs" | "includeBaseHeaders"
  > = {}
): Promise<{ status: number; statusText: string; headers: Record<string, string> }> {
  // Same base-header semantics as `rawRequest`, so a probe does not silently
  // acquire auth it meant to omit just because it reads headers only.
  const headers = new Headers(
    options.includeBaseHeaders === false ? {} : baseHeaders(ctx)
  );
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers.set(name, value);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? ctx.config.checkTimeout
  );
  try {
    const response = await ctx.fetchFn(options.url ?? ctx.serverUrl, {
      method: options.method ?? "GET",
      headers,
      signal: controller.signal,
    });
    const captured: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      captured[key.toLowerCase()] = value;
    });
    // The verdict is in hand, so release the stream instead of reading it: an
    // accepted SSE stream never ends, and a probe that walks away without
    // closing leaves the server under test writing into a socket nobody
    // reads. Cancelling the body is the clean release; the abort also covers a
    // response that carried no body at all.
    await response.body?.cancel().catch(() => undefined);
    controller.abort();
    return {
      status: response.status,
      statusText: response.statusText,
      headers: captured,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Every JSON-RPC message on the response, whether it arrived as JSON or SSE. */
export function jsonRpcMessages(result: RawHttpResult): unknown[] {
  if (result.sse) {
    return result.sse
      .map((event) => event.json)
      .filter((json): json is unknown => json !== undefined);
  }
  return result.json === undefined ? [] : [result.json];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The in-band JSON-RPC error, if the response carried one. Deliberately
 * SEPARATE from the HTTP status: on the modern wire an HTTP 400 arrives with a
 * well-formed JSON-RPC error body, and a check must be able to assert those as
 * two independent facts.
 */
export function jsonRpcError(
  result: RawHttpResult
): JsonRpcErrorShape | undefined {
  for (const message of jsonRpcMessages(result)) {
    const error = asRecord(asRecord(message)?.error);
    if (
      error &&
      typeof error.code === "number" &&
      typeof error.message === "string"
    ) {
      return {
        code: error.code,
        message: error.message,
        data: error.data,
      };
    }
  }
  return undefined;
}

/** The in-band JSON-RPC `result` payload, if the response carried one. */
export function jsonRpcResult(
  result: RawHttpResult
): Record<string, unknown> | undefined {
  for (const message of jsonRpcMessages(result)) {
    const payload = asRecord(asRecord(message)?.result);
    if (payload) {
      return payload;
    }
  }
  return undefined;
}

/** JSON-RPC notifications carried on the response (SSE frames or a JSON body). */
export function jsonRpcNotifications(
  result: RawHttpResult
): Array<Record<string, unknown>> {
  return jsonRpcMessages(result)
    .map((message) => asRecord(message))
    .filter(
      (message): message is Record<string, unknown> =>
        message !== undefined &&
        typeof message.method === "string" &&
        message.id === undefined
    );
}
