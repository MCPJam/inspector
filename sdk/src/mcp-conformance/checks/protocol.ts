import type {
  MCPCheckId,
  MCPCheckResult,
  RawHttpCheckContext,
} from "../types.js";
import { CHECK_ERAS } from "../types.js";
import {
  eraSkipMessage,
  failedResult,
  passedResult,
  skippedResult,
} from "./helpers.js";

// JSON-RPC "Method not found" — the only conforming error for an unrecognized
// method name (JSON-RPC 2.0 §5.1). Accepting any numeric code would let a
// server pass this check with an unrelated error (e.g. -32602 Invalid params).
const METHOD_NOT_FOUND = -32601;

const PROTOCOL_CHECK_METADATA = {
  "protocol-invalid-method-error": {
    id: "protocol-invalid-method-error",
    category: "protocol",
    title: "Invalid Method Error",
    description:
      "Server returns a valid JSON-RPC error for an unrecognized method name.",
  },
} as const satisfies Record<
  Extract<MCPCheckId, "protocol-invalid-method-error">,
  Pick<MCPCheckResult, "id" | "category" | "title" | "description">
>;

const INVALID_METHOD = "nonexistent/method_that_does_not_exist";

function buildBaseHeaders(ctx: RawHttpCheckContext): Record<string, string> {
  return {
    ...(ctx.config.customHeaders ?? {}),
    ...(ctx.config.accessToken
      ? { Authorization: `Bearer ${ctx.config.accessToken}` }
      : {}),
  };
}

/**
 * Legacy prelude: run the `initialize` handshake and return the session id
 * (if the server mints one). Modern (sessionless) runs skip this entirely.
 * The protocol version pinned by the run drives the handshake; unset ⇒
 * `"2025-11-25"`, byte-identical to the pre-era-awareness behavior.
 */
async function initializeAndGetSession(
  ctx: RawHttpCheckContext,
): Promise<string | undefined> {
  const response = await ctx.fetchFn(ctx.serverUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...buildBaseHeaders(ctx),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: ctx.config.protocolVersion ?? "2025-11-25",
        capabilities: {},
        clientInfo: {
          name: "mcpjam-sdk-conformance",
          version: "1.0.0",
        },
      },
    }),
  });

  return response.headers.get("mcp-session-id") ?? undefined;
}

/**
 * Send the invalid-method probe.
 *
 *   - Legacy: `initialize` first (to obtain a session for stateful servers),
 *     then the bad-method POST carrying the session id.
 *   - Modern (2026 era): no prelude. The 2026 era is sessionless, so the
 *     bad-method POST stands alone, framed with the `MCP-Protocol-Version`
 *     header and the per-request `_meta` protocol-version envelope the modern
 *     wire requires (plus the SEP-2243 `mcp-method` mirror header).
 */
async function sendInvalidMethodProbe(
  ctx: RawHttpCheckContext,
): Promise<Response> {
  if (ctx.config.era === "modern") {
    const version = ctx.config.protocolVersion ?? "2025-11-25";
    // Build with a `Headers` instance so probe-owned fields win by
    // case-insensitive NAME, not by object-key ordering. A plain object keeps
    // `MCP-Method` and `mcp-method` as two distinct keys; Fetch then normalizes
    // both to the canonical `mcp-method` and CONCATENATES their values
    // ("tools/list, __invalid__"), so a caller's `customHeaders` case-variant
    // would blend into the probe header and turn an honest probe into a false
    // failure. `headers.set(...)` after the base spread REPLACES any such
    // collision regardless of the caller's casing.
    const headers = new Headers({
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...buildBaseHeaders(ctx),
    });
    headers.set("MCP-Protocol-Version", version);
    headers.set("mcp-method", INVALID_METHOD);
    return await ctx.fetchFn(ctx.serverUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: INVALID_METHOD,
        params: {
          // The 2026-07-28 wire requires the FULL per-request `_meta` envelope
          // (protocolVersion + clientInfo + clientCapabilities). Sending only
          // the version makes a conforming server reject the request as a
          // malformed envelope (-32602) BEFORE it ever dispatches the method,
          // so the probe would never actually exercise unknown-method handling.
          // clientInfo / clientCapabilities mirror the legacy `initialize`.
          _meta: {
            "io.modelcontextprotocol/protocolVersion": version,
            "io.modelcontextprotocol/clientInfo": {
              name: "mcpjam-sdk-conformance",
              version: "1.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
  }

  const sessionId = await initializeAndGetSession(ctx);
  return await ctx.fetchFn(ctx.serverUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...buildBaseHeaders(ctx),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: INVALID_METHOD,
      params: {},
    }),
  });
}

export async function runProtocolChecks(
  ctx: RawHttpCheckContext,
  selectedCheckIds: Set<MCPCheckId>,
): Promise<MCPCheckResult[]> {
  const results: MCPCheckResult[] = [];

  if (!selectedCheckIds.has("protocol-invalid-method-error")) {
    return results;
  }

  // Era gate: route the raw protocol track through CHECK_ERAS, the single
  // source of truth shared with the client / security / transport tracks. The
  // invalid-method probe currently applies to both eras, so this is inert
  // today — but keeping the runner on the map means a future reclassification
  // (e.g. the Phase 3 safety valve downgrading it to legacy-only) becomes a
  // safe era-skip instead of silently drifting into a false failure.
  if (!CHECK_ERAS["protocol-invalid-method-error"].includes(ctx.config.era)) {
    results.push(
      skippedResult(
        PROTOCOL_CHECK_METADATA["protocol-invalid-method-error"],
        eraSkipMessage(ctx.config.era, ctx.config.protocolVersion),
      ),
    );
    return results;
  }

  const startedAt = Date.now();
  try {
    const response = await sendInvalidMethodProbe(ctx);

    const contentType = response.headers.get("content-type") ?? "";
    let body: unknown;

    if (contentType.includes("text/event-stream")) {
      const text = await response.text();
      const dataLine = text
        .split(/\r?\n/)
        .find((line) => line.startsWith("data:"));
      body = dataLine
        ? JSON.parse(dataLine.slice(dataLine.indexOf(":") + 1).trim())
        : undefined;
    } else {
      body = await response.json();
    }

    const rpcResponse = body as Record<string, unknown> | undefined;
    const rpcError =
      rpcResponse?.error && typeof rpcResponse.error === "object"
        ? (rpcResponse.error as Record<string, unknown>)
        : undefined;

    if (!rpcError) {
      results.push(
        failedResult(
          PROTOCOL_CHECK_METADATA["protocol-invalid-method-error"],
          Date.now() - startedAt,
          "Server did not return a JSON-RPC error object for an invalid method",
          {
            status: response.status,
            body: rpcResponse,
          },
        ),
      );
      return results;
    }

    const hasCode = typeof rpcError.code === "number";
    const hasMessage = typeof rpcError.message === "string";

    if (!hasCode || !hasMessage) {
      results.push(
        failedResult(
          PROTOCOL_CHECK_METADATA["protocol-invalid-method-error"],
          Date.now() - startedAt,
          `JSON-RPC error is malformed: ${!hasCode ? "missing numeric code" : "missing message string"}`,
          {
            status: response.status,
            error: rpcError,
          },
        ),
      );
      return results;
    }

    if (rpcError.code !== METHOD_NOT_FOUND) {
      results.push(
        failedResult(
          PROTOCOL_CHECK_METADATA["protocol-invalid-method-error"],
          Date.now() - startedAt,
          `Expected JSON-RPC error code ${METHOD_NOT_FOUND} (Method not found) for an unrecognized method, got ${String(rpcError.code)}`,
          {
            status: response.status,
            error: rpcError,
          },
        ),
      );
      return results;
    }

    results.push(
      passedResult(
        PROTOCOL_CHECK_METADATA["protocol-invalid-method-error"],
        Date.now() - startedAt,
        {
          status: response.status,
          errorCode: rpcError.code,
          errorMessage: rpcError.message,
        },
      ),
    );
  } catch (error) {
    results.push(
      failedResult(
        PROTOCOL_CHECK_METADATA["protocol-invalid-method-error"],
        Date.now() - startedAt,
        error instanceof Error ? error.message : String(error),
        undefined,
        error,
      ),
    );
  }

  return results;
}
