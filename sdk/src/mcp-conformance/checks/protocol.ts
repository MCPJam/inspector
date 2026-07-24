import type {
  MCPCheckId,
  MCPCheckResult,
  RawHttpCheckContext,
} from "../types.js";
import {
  failedResult,
  passedResult,
} from "./helpers.js";

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
    return await ctx.fetchFn(ctx.serverUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": version,
        "mcp-method": INVALID_METHOD,
        ...buildBaseHeaders(ctx),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: INVALID_METHOD,
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": version,
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
