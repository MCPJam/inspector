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
    category: "core",
    title: "Invalid Method Error",
    description:
      "Server returns a valid JSON-RPC error for an unrecognized method name.",
  },
} as const satisfies Record<
  Extract<MCPCheckId, "protocol-invalid-method-error">,
  Pick<MCPCheckResult, "id" | "category" | "title" | "description">
>;

function buildBaseHeaders(ctx: RawHttpCheckContext): Record<string, string> {
  return {
    ...(ctx.config.customHeaders ?? {}),
    ...(ctx.config.accessToken
      ? { Authorization: `Bearer ${ctx.config.accessToken}` }
      : {}),
  };
}

async function initializeAndGetSession(
  ctx: RawHttpCheckContext,
): Promise<string | undefined> {
  const response = await fetch(ctx.serverUrl, {
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
        protocolVersion: "2025-11-25",
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
    const sessionId = await initializeAndGetSession(ctx);

    const response = await fetch(ctx.serverUrl, {
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
        method: "nonexistent/method_that_does_not_exist",
        params: {},
      }),
    });

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
