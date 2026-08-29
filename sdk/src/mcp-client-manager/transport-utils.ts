/**
 * Transport utilities for MCPClientManager
 */

import type {
  Transport,
  TransportSendOptions,
  JSONRPCMessage,
  MessageExtraInfo,
  StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/client";
import type { RpcLogger } from "./types.js";
import { isTasksExtensionEra } from "./tasks-dispatch.js";
// The send side and the Tracing verdict read ONE set, so a method added to the
// SEP-2663 routing requirement cannot be sent-but-unjudged (or vice versa).
import { TASK_ROUTED_METHODS } from "./mcp-header-mirror.js";

/**
 * Normalizes headers from various formats (Headers, string[][], or plain object)
 * into a plain Record<string, string>.
 *
 * @param headers - Headers in any supported format
 * @returns Plain object with header key-value pairs
 */
export function normalizeHeaders(
  headers: HeadersInit | undefined
): Record<string, string> {
  if (!headers) {
    return {};
  }

  // If it's already a plain object (not Headers or array), return as-is
  if (
    typeof headers === "object" &&
    !Array.isArray(headers) &&
    !(headers instanceof Headers)
  ) {
    return headers as Record<string, string>;
  }

  // Convert Headers or string[][] to a plain object
  const normalized: Record<string, string> = {};
  const headersObj = new Headers(headers);
  headersObj.forEach((value, key) => {
    normalized[key] = value;
  });
  return normalized;
}

/**
 * Checks if headers contain an Authorization header (case-insensitive check).
 *
 * @param headers - Normalized headers object
 * @returns The Authorization value if present, undefined otherwise
 */
export function getExistingAuthorization(
  headers: Record<string, string>
): string | undefined {
  return headers["Authorization"] ?? headers["authorization"];
}

/**
 * Builds the requestInit object, merging accessToken into Authorization header if provided.
 *
 * @param accessToken - Optional access token for Bearer auth
 * @param requestInit - Optional existing requestInit config
 * @returns Merged requestInit with Authorization header if accessToken provided
 */
export function buildRequestInit(
  accessToken: string | undefined,
  requestInit: StreamableHTTPClientTransportOptions["requestInit"]
): StreamableHTTPClientTransportOptions["requestInit"] {
  if (!accessToken) {
    return requestInit;
  }

  const existingHeaders = normalizeHeaders(requestInit?.headers);
  const existingAuth = getExistingAuthorization(existingHeaders);

  // Remove any lowercase 'authorization' key to avoid duplicate headers
  const { authorization: _, ...headersWithoutLowercaseAuth } = existingHeaders;

  return {
    ...requestInit,
    headers: {
      Authorization: existingAuth ?? `Bearer ${accessToken}`,
      ...headersWithoutLowercaseAuth,
    },
  };
}

/**
 * Returns a copy of requestInit without Authorization headers.
 *
 * buildRequestInit intentionally preserves caller-provided auth, so token
 * rotation must first remove stale auth headers before supplying a new
 * accessToken.
 */
export function stripAuthorizationFromRequestInit(
  requestInit: StreamableHTTPClientTransportOptions["requestInit"]
): StreamableHTTPClientTransportOptions["requestInit"] {
  if (!requestInit?.headers) {
    return requestInit;
  }

  const normalized = normalizeHeaders(requestInit.headers);
  const nextHeaders = Object.fromEntries(
    Object.entries(normalized).filter(
      ([key]) => key.toLowerCase() !== "authorization"
    )
  );

  return {
    ...requestInit,
    headers: nextHeaders,
  };
}

/**
 * Creates a logging wrapper transport that logs JSON-RPC traffic.
 *
 * @param serverId - The server ID for logging context
 * @param logger - The RPC logger function
 * @param transport - The underlying transport to wrap
 * @returns A new transport that logs all messages
 */
export function wrapTransportForLogging(
  serverId: string,
  logger: RpcLogger,
  transport: Transport
): Transport {
  class LoggingTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

    constructor(private readonly inner: Transport) {
      this.inner.onmessage = (
        message: JSONRPCMessage,
        extra?: MessageExtraInfo
      ) => {
        try {
          logger({ direction: "receive", message, serverId });
        } catch {
          // Ignore logger errors
        }
        this.onmessage?.(message, extra);
      };
      this.inner.onclose = () => {
        this.onclose?.();
      };
      this.inner.onerror = (error: Error) => {
        this.onerror?.(error);
      };
    }

    async start(): Promise<void> {
      if (typeof (this.inner as any).start === "function") {
        await (this.inner as any).start();
      }
    }

    async send(
      message: JSONRPCMessage,
      options?: TransportSendOptions
    ): Promise<void> {
      try {
        logger({ direction: "send", message, serverId });
      } catch {
        // Ignore logger errors
      }
      await this.inner.send(message as any, options as any);
    }

    async close(): Promise<void> {
      await this.inner.close();
    }

    get sessionId(): string | undefined {
      return (this.inner as any).sessionId;
    }

    setProtocolVersion?(version: string): void {
      if (typeof this.inner.setProtocolVersion === "function") {
        this.inner.setProtocolVersion(version);
      }
    }
  }

  return new LoggingTransport(transport);
}

/**
 * Creates a default console logger for JSON-RPC traffic.
 *
 * @returns A logger function that outputs to console.debug
 */
export function createDefaultRpcLogger(): RpcLogger {
  return ({ direction, message, serverId }) => {
    let printable: string;
    try {
      printable =
        typeof message === "string" ? message : JSON.stringify(message);
    } catch {
      printable = String(message);
    }

    console.debug(`[MCP:${serverId}] ${direction.toUpperCase()} ${printable}`);
  };
}

// ============================================================================
// Tasks extension: `Mcp-Name` routing header
// ============================================================================

function taskRoutingHeadersFor(
  body: unknown
): { name: string; method: string } | undefined {
  if (typeof body !== "string" || !body.includes("tasks/")) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  // A batch is not a task RPC shape we emit; only single requests are routed.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const { method, params } = parsed as {
    method?: unknown;
    params?: { taskId?: unknown };
  };
  if (typeof method !== "string" || !TASK_ROUTED_METHODS.has(method)) {
    return undefined;
  }
  const taskId = params?.taskId;
  return typeof taskId === "string" && taskId.length > 0
    ? { name: taskId, method }
    : undefined;
}

/**
 * Wraps a transport `fetch` so `tasks/get|update|cancel` POSTs carry the
 * SEP-2663 routing headers.
 *
 * beta.4's Streamable HTTP transport derives `mcp-name` from `params.name` /
 * `params.uri` only — never from `params.taskId` — so without this wrapper a
 * task poll reaches a routed deployment without its routing key. `mcp-method`
 * is set only when absent, so an envelope beta.4 already wrote wins; existing
 * `mcp-name` values are likewise never overwritten. Body sniffing is the only
 * seam available (the transport does not expose the outgoing message here),
 * so it is contained in this one function and covered by its own test —
 * re-verify on every `@modelcontextprotocol/client` bump.
 */
export function wrapFetchForTaskRouting(
  fetchFn?: typeof fetch
): typeof fetch {
  const base = fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const routing = taskRoutingHeadersFor(init?.body);
    if (!routing) {
      return base(input as never, init as never);
    }
    const headers = new Headers(init?.headers);
    // Era gate: the routing headers only exist in the extension era. A legacy
    // 2025-11-25 `tasks/get` poll must go out byte-identical to what the
    // in-core spec defines.
    if (!isTasksExtensionEra(headers.get("mcp-protocol-version") ?? undefined)) {
      return base(input as never, init as never);
    }
    if (!headers.has("mcp-name")) {
      headers.set("mcp-name", routing.name);
    }
    if (!headers.has("mcp-method")) {
      headers.set("mcp-method", routing.method);
    }
    return base(input as never, { ...init, headers } as never);
  }) as typeof fetch;
}

/**
 * Simulates a client that never opens the server→client notification channel
 * — `hostConfig.mcpProfile.toolListChanged.listens: false`.
 *
 * WHY A FETCH WRAPPER. The upstream client opens the standalone GET SSE
 * stream itself, from inside `StreamableHTTPClientTransport._send`, the moment
 * the server answers `202` to `notifications/initialized`. It exposes no
 * option to skip it, so the injected fetch is the only seam we own.
 *
 * The refusal is a local `405`, which is exactly what the Streamable HTTP spec
 * says a server returns when it does not offer a stream, and what the upstream
 * transport already tolerates: it swallows that status and leaves the
 * connection healthy on the POST channel. Answering with a network error
 * instead would surface as a broken connection rather than a client that
 * chose not to listen.
 *
 * NOT APPLICABLE to the legacy HTTP+SSE transport, where the GET stream IS the
 * connection — a real client on that transport cannot not-listen either, so
 * the knob is a documented no-op there rather than a connection failure.
 */
export function wrapFetchForNoListenChannel(
  fetchFn?: typeof fetch
): typeof fetch {
  const base =
    fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    // The standalone listen stream is the ONLY GET the Streamable HTTP
    // transport issues; every request carrying a JSON-RPC message is a POST,
    // so method alone identifies it without sniffing bodies.
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      return base(input as never, init as never);
    }
    const accept = new Headers(init?.headers).get("accept") ?? "";
    if (!accept.includes("text/event-stream")) {
      return base(input as never, init as never);
    }
    return Promise.resolve(
      new Response(null, {
        status: 405,
        statusText: "Method Not Allowed",
      })
    );
  }) as typeof fetch;
}

/**
 * Simulates a client that ignores `notifications/tools/list_changed` —
 * `hostConfig.mcpProfile.toolListChanged.refetches: false`.
 *
 * MECHANISM. mcpjam never registers an auto-refetch handler (we do not pass
 * `ClientOptions.listChanged`), so the observable "re-fetch" is upstream's
 * unconditional response-cache eviction: on this notification the client
 * evicts its cached `tools/list`, and the next `listTools()` therefore goes to
 * the wire instead of serving cache. Dropping the frame before the client sees
 * it keeps the cache — and the stale tool list — in place, which is precisely
 * what a server author sees from a host that ignores the notification.
 *
 * Dropping at the transport rather than filtering the handler also stops the
 * notification reaching the subscription coordinator, so one wrapper covers
 * every consumer instead of each one remembering to check the knob.
 *
 * Compose OUTERMOST for the same reason as the first-page-only wrapper: the
 * logging transport underneath still records the frame the server really sent,
 * so the wire log shows the notification arriving and being ignored, not a
 * server that never sent it.
 */
export function wrapTransportForDroppedListChanged(
  transport: Transport
): Transport {
  class DroppedListChangedTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

    constructor(private readonly inner: Transport) {
      this.inner.onmessage = (
        message: JSONRPCMessage,
        extra?: MessageExtraInfo
      ) => {
        const record = message as { method?: unknown; id?: unknown };
        // Notifications only: a request carrying an id must never be
        // swallowed, or the caller would wait forever for a response.
        if (
          record.id === undefined &&
          record.method === "notifications/tools/list_changed"
        ) {
          return;
        }
        this.onmessage?.(message, extra);
      };
      this.inner.onclose = () => this.onclose?.();
      this.inner.onerror = (error: Error) => this.onerror?.(error);
    }

    async start(): Promise<void> {
      if (typeof (this.inner as any).start === "function") {
        await (this.inner as any).start();
      }
    }

    async send(
      message: JSONRPCMessage,
      options?: TransportSendOptions
    ): Promise<void> {
      await this.inner.send(message as any, options as any);
    }

    async close(): Promise<void> {
      await this.inner.close();
    }

    get sessionId(): string | undefined {
      return (this.inner as any).sessionId;
    }

    setProtocolVersion?(version: string): void {
      if (typeof this.inner.setProtocolVersion === "function") {
        this.inner.setProtocolVersion(version);
      }
    }
  }

  return new DroppedListChangedTransport(transport);
}

// ============================================================================
// Tasks extension: recovering `resultType: "task"` responses from beta.4
// ============================================================================

/**
 * `_meta` key carrying an intercepted SEP-2663 `CreateTaskResult` through
 * beta.4's result decoder. Private to this SDK — never sent on the wire.
 */
export const TASK_CREATED_META_KEY =
  "io.mcpjam/tasks/create-task-result" as const;

/**
 * Wraps a transport so an SEP-2663 `CreateTaskResult` survives beta.4's
 * result decoder.
 *
 * beta.4's 2026 codec (`decodeResult`, client `src-*.mjs:3864`) accepts only
 * `resultType` `"complete"` and `"input_required"`; anything else — including
 * the extension's `"task"` — is decoded as `kind: "invalid"` and the request
 * REJECTS with `SdkError(UNSUPPORTED_RESULT_TYPE)`, whose `data` carries the
 * `resultType` string but NOT the payload. There is no client option (no
 * `allowTaskResult` counterpart to `allowInputRequired`) and no pluggable
 * codec, so a task creation would be unrecoverable at the `Client` layer.
 *
 * This wrapper therefore rewrites the inbound JSON-RPC response *before* the
 * decoder sees it: `{resultType:"task", …task}` becomes a minimal valid
 * complete result whose `_meta[TASK_CREATED_META_KEY]` holds the original
 * payload verbatim. `MCPClientManager` unwraps it and returns the
 * `CreateTaskResult`. Nothing else is touched: non-task responses, requests,
 * and notifications pass through by identity, and no bytes are changed on the
 * outbound side.
 *
 * Remove this when the client package can surface `resultType: "task"`
 * natively.
 */
export function wrapTransportForTaskResults(transport: Transport): Transport {
  class TaskResultTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
    /** Negotiated version, learned from the client's `setProtocolVersion`. */
    private protocolVersion: string | undefined;

    constructor(private readonly inner: Transport) {
      this.inner.onmessage = (
        message: JSONRPCMessage,
        extra?: MessageExtraInfo
      ) => {
        // Sanitize on every era: a server must never be able to speak the
        // private smuggling key itself.
        const sanitized = stripTaskCreatedMetaKey(message);
        // Era gate: a pre-2026 server that claims `resultType: "task"` is
        // nonconforming, and a debugger must show that rather than silently
        // rewriting it into a task.
        this.onmessage?.(
          isTasksExtensionEra(this.protocolVersion)
            ? rewriteTaskResultMessage(sanitized)
            : sanitized,
          extra
        );
      };
      this.inner.onclose = () => this.onclose?.();
      this.inner.onerror = (error: Error) => this.onerror?.(error);
    }

    async start(): Promise<void> {
      if (typeof (this.inner as any).start === "function") {
        await (this.inner as any).start();
      }
    }

    async send(
      message: JSONRPCMessage,
      options?: TransportSendOptions
    ): Promise<void> {
      await this.inner.send(message as any, options as any);
    }

    async close(): Promise<void> {
      await this.inner.close();
    }

    get sessionId(): string | undefined {
      return (this.inner as any).sessionId;
    }

    setProtocolVersion?(version: string): void {
      this.protocolVersion = version;
      if (typeof this.inner.setProtocolVersion === "function") {
        this.inner.setProtocolVersion(version);
      }
    }
  }

  return new TaskResultTransport(transport);
}

/**
 * Removes an inbound `_meta[TASK_CREATED_META_KEY]` — the key is private to
 * this SDK, so anything arriving with it is a server trying to forge a task
 * envelope. Exported for tests.
 */
export function stripTaskCreatedMetaKey(
  message: JSONRPCMessage
): JSONRPCMessage {
  const result = (message as { result?: unknown }).result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return message;
  }
  const meta = (result as { _meta?: unknown })._meta;
  if (
    typeof meta !== "object" ||
    meta === null ||
    !(TASK_CREATED_META_KEY in (meta as Record<string, unknown>))
  ) {
    return message;
  }
  const { [TASK_CREATED_META_KEY]: _forged, ...rest } = meta as Record<
    string,
    unknown
  >;
  return {
    ...(message as Record<string, unknown>),
    result: { ...(result as Record<string, unknown>), _meta: rest },
  } as unknown as JSONRPCMessage;
}

/** Exported for tests: the pure message rewrite the wrapper applies. */
export function rewriteTaskResultMessage(
  message: JSONRPCMessage
): JSONRPCMessage {
  const result = (message as { result?: unknown }).result;
  if (
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result) ||
    (result as { resultType?: unknown }).resultType !== "task"
  ) {
    return message;
  }
  return {
    ...(message as Record<string, unknown>),
    result: {
      resultType: "complete",
      content: [],
      _meta: { [TASK_CREATED_META_KEY]: result },
    },
  } as unknown as JSONRPCMessage;
}

/**
 * The paginated list methods whose aggregation a first-page-only client
 * truncates. `resources/templates/list` is spelled in full — it is a distinct
 * method, not a variant of `resources/list`.
 */
const PAGINATED_LIST_METHODS: ReadonlySet<string> = new Set([
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
]);

/**
 * Simulates a client that reads page one of a paginated list and stops —
 * `hostConfig.mcpProfile.paginationTraversal: "firstPageOnly"`. Several real
 * hosts behave this way, and a server author's question ("do my important
 * tools survive such a host?") can only be answered by actually being one.
 *
 * MECHANISM. The official client aggregates pages internally: `_listAllPages`
 * reads `nextCursor` off the page-one *result* and loops until it is absent.
 * Deleting that field from the inbound response frame therefore ends the walk
 * after one page, with two consequences that are both the point:
 *
 *   1. `listTools()` returns only page one.
 *   2. The aggregate the client writes to its response cache is page-one-only,
 *      and that cache is the source `ensureXMcpHeaderMirroringSource` reads to
 *      mirror SEP-2243 `Mcp-Param-*` headers. So a `tools/call` on a page-two
 *      tool goes out with no mirrored header and a strict server answers
 *      `-32020` — exactly how a real first-page-only client fails.
 *
 * WHY A TRANSPORT WRAPPER, not the fetch seam: `wrapFetchForHttpLogging`
 * deliberately never reads response bodies (doing so would consume the stream
 * the transport is about to parse, and would break SSE framing). Mutating at
 * the JSON-RPC frame level avoids both, and works on stdio as well as HTTP —
 * a first-page-only client is not an HTTP-specific defect.
 *
 * ONLY the cursor-less request is truncated. `_listAllPages` enters with no
 * `cursor` param, so that is the aggregation this knob models. A request that
 * carries an explicit cursor is the debugger's own manual paging — a
 * deliberate operator action, not something the emulated client did — and
 * truncating it would break a feature rather than simulate a client. Ids are
 * correlated outbound → inbound so an unrelated `nextCursor` is never touched.
 *
 * Era-agnostic: pagination has existed since `2025-03-26`.
 *
 * Compose OUTERMOST, so the logging transport underneath records the frame the
 * server really sent and only the client sees the truncated one — the same
 * "log the raw bytes, mutate above them" ordering the task wrapper uses.
 */
export function wrapTransportForFirstPageOnly(transport: Transport): Transport {
  class FirstPageOnlyTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
    /**
     * Ids of in-flight cursor-less paginated list requests. An entry is
     * removed by the response that matches it (result OR error), so this
     * cannot grow without bound on a long-lived connection.
     */
    private readonly pendingListRequestIds = new Set<string>();

    constructor(private readonly inner: Transport) {
      this.inner.onmessage = (
        message: JSONRPCMessage,
        extra?: MessageExtraInfo
      ) => {
        this.onmessage?.(this.truncateIfFirstPage(message), extra);
      };
      this.inner.onclose = () => {
        this.pendingListRequestIds.clear();
        this.onclose?.();
      };
      this.inner.onerror = (error: Error) => this.onerror?.(error);
    }

    private truncateIfFirstPage(message: JSONRPCMessage): JSONRPCMessage {
      const id = (message as { id?: unknown }).id;
      if (id === undefined || id === null) return message;
      const key = String(id);
      if (!this.pendingListRequestIds.has(key)) return message;
      // Any response for this id closes the correlation, error included.
      this.pendingListRequestIds.delete(key);
      return stripNextCursorFromListResult(message);
    }

    async start(): Promise<void> {
      if (typeof (this.inner as any).start === "function") {
        await (this.inner as any).start();
      }
    }

    async send(
      message: JSONRPCMessage,
      options?: TransportSendOptions
    ): Promise<void> {
      const record = message as {
        id?: unknown;
        method?: unknown;
        params?: { cursor?: unknown };
      };
      if (
        record.id !== undefined &&
        record.id !== null &&
        typeof record.method === "string" &&
        PAGINATED_LIST_METHODS.has(record.method) &&
        record.params?.cursor === undefined
      ) {
        this.pendingListRequestIds.add(String(record.id));
      }
      await this.inner.send(message as any, options as any);
    }

    async close(): Promise<void> {
      this.pendingListRequestIds.clear();
      await this.inner.close();
    }

    get sessionId(): string | undefined {
      return (this.inner as any).sessionId;
    }

    setProtocolVersion?(version: string): void {
      if (typeof this.inner.setProtocolVersion === "function") {
        this.inner.setProtocolVersion(version);
      }
    }
  }

  return new FirstPageOnlyTransport(transport);
}

/**
 * Removes `nextCursor` from a JSON-RPC *result*, which is what makes the
 * official client's page walk stop. Returns the message by identity when
 * there is nothing to strip, so non-list traffic is untouched. Exported for
 * unit tests. Correlating the id to a cursor-less list request is the
 * CALLER's job — this function does not inspect the method.
 */
export function stripNextCursorFromListResult(
  message: JSONRPCMessage
): JSONRPCMessage {
  const result = (message as { result?: unknown }).result;
  if (
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result) ||
    (result as { nextCursor?: unknown }).nextCursor === undefined
  ) {
    return message;
  }
  const { nextCursor: _truncated, ...rest } = result as Record<string, unknown>;
  return {
    ...(message as Record<string, unknown>),
    result: rest,
  } as unknown as JSONRPCMessage;
}
