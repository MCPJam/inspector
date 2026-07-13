// Pure MCP `initialize` request builder + response evaluator for the XAA flow.
// Browser- and node-safe: it produces the request headers/body and interprets a
// response body, but performs no I/O — the caller supplies the transport (the
// node CLI uses the debug OAuth proxy; the browser uses the server proxy).
//
// Reused by the CLI immediately so its behavior is protected before the shared
// state machine adopts it.

/** Evidence for whether a capability/extension is advertised by the AS/server. */
export type XaaCapabilityEvidence =
  | "advertised"
  | "not_advertised"
  | "unknown";

/** JSON-RPC id sent on the XAA debugger's `initialize`; the response must echo it. */
export const MCP_INIT_ID = "mcpjam-xaa-cli";
/** Protocol version advertised in the params and the MCP-Protocol-Version header. */
export const MCP_PROTOCOL_VERSION = "2025-11-25";
/** The MCP Enterprise-Managed Authorization extension key. */
export const XAA_MCP_EXTENSION =
  "io.modelcontextprotocol/enterprise-managed-authorization";

export interface McpInitializeRequest {
  headers: Record<string, string>;
  body: {
    jsonrpc: "2.0";
    id: string;
    method: "initialize";
    params: Record<string, unknown>;
  };
}

/**
 * Build the authenticated MCP `initialize` request: the bearer + protocol
 * headers and a JSON-RPC body that advertises the enterprise-managed
 * authorization extension. Some 2025-11-25 servers enforce the
 * MCP-Protocol-Version header, so it is sent alongside the params version.
 */
export function buildMcpInitializeRequest(
  accessToken: string,
): McpInitializeRequest {
  return {
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      Authorization: `Bearer ${accessToken}`,
    },
    body: {
      jsonrpc: "2.0",
      id: MCP_INIT_ID,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          extensions: { [XAA_MCP_EXTENSION]: {} },
        },
        clientInfo: { name: "MCPJam XAA CLI", version: "1.0.0" },
      },
    },
  };
}

// Unwrap the debug proxy's SSE envelope: the JSON-RPC payload sits under
// `mcpResponse` for a text/event-stream reply; a plain JSON body IS the payload.
function jsonRpcPayload(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const record = body as Record<string, unknown>;
  return record.transport === "sse" ? record.mcpResponse : body;
}

function jsonRpcErrorFrom(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  const parts: string[] = [];
  if (typeof code === "number") parts.push(String(code));
  if (typeof message === "string" && message.length > 0) parts.push(message);
  return parts.length > 0 ? parts.join(": ") : "JSON-RPC error";
}

/**
 * Evaluate an `initialize` response body. Returns a failure reason, or undefined
 * when the server returned a genuine JSON-RPC initialize result (right protocol
 * version, echoed id, object result). Handles SSE envelopes, top-level proxy
 * error strings, JSON-RPC errors, and non-MCP 2xx bodies.
 */
export function evaluateMcpInitializeResponse(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const topError = (body as { error?: unknown }).error;
    if (typeof topError === "string" && topError.length > 0) return topError;
  }
  const payload = jsonRpcPayload(body);
  const rpcError = jsonRpcErrorFrom(payload);
  if (rpcError) return rpcError;

  const response = payload as {
    jsonrpc?: unknown;
    id?: unknown;
    result?: unknown;
  };
  if (
    !payload ||
    typeof payload !== "object" ||
    response.jsonrpc !== "2.0" ||
    response.id !== MCP_INIT_ID ||
    response.result === null ||
    typeof response.result !== "object"
  ) {
    return "MCP server did not return a JSON-RPC initialize result";
  }
  return undefined;
}

/**
 * Whether the `initialize` result advertises the enterprise-managed
 * authorization extension in its capabilities.
 */
export function mcpInitializeExtensionEvidence(
  body: unknown,
): XaaCapabilityEvidence {
  const payload = jsonRpcPayload(body);
  if (!payload || typeof payload !== "object") return "unknown";
  const result = (payload as { result?: unknown }).result;
  if (!result || typeof result !== "object") return "unknown";
  const capabilities = (result as { capabilities?: unknown }).capabilities;
  if (!capabilities || typeof capabilities !== "object") return "unknown";
  const extensions = (capabilities as { extensions?: unknown }).extensions;
  if (!extensions || typeof extensions !== "object") return "unknown";
  return Object.prototype.hasOwnProperty.call(extensions, XAA_MCP_EXTENSION)
    ? "advertised"
    : "not_advertised";
}
