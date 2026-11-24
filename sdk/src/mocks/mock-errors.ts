import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";

/**
 * JSON-RPC error codes a mock returns. Errors stay JSON-RPC because the hosted
 * fetch blanks any other error body. `data.mockCode` carries the name so a
 * caller does not have to match on message text.
 */
export const MOCK_ERROR_CODES = {
  /** `tools/list`: the definition edits a tool the real server no longer lists. */
  editedToolMissing: -32011,
  /** The real server could not be reached for the handshake. */
  realUnreachable: -32012,
  /** A method one side lacks (JSON-RPC method not found). */
  methodUnavailable: ProtocolErrorCode.MethodNotFound,
  /** `tools/call` for a name the mock does not list (JSON-RPC invalid params). */
  toolNotFound: ProtocolErrorCode.InvalidParams,
} as const;

export interface MissingEditedTool {
  /** The name the definition gives the entry. */
  tool: string;
  /** The real tool the entry points at. */
  realTool: string;
}

export function editedToolMissingError(
  missing: MissingEditedTool[]
): ProtocolError {
  const names = missing.map((m) =>
    m.tool === m.realTool
      ? `"${m.tool}"`
      : `"${m.tool}" (real tool "${m.realTool}")`
  );
  return new ProtocolError(
    MOCK_ERROR_CODES.editedToolMissing,
    `The mock edits ${names.join(", ")}, which the real server no longer lists. Update the mock to drop or retarget ${missing.length === 1 ? "that edit" : "those edits"}.`,
    { mockCode: "mock_edited_tool_missing", tools: missing }
  );
}

export function methodUnavailableError(
  method: string,
  side: "mock" | "real",
  family: string
): ProtocolError {
  const who =
    side === "mock"
      ? "this mock does not offer"
      : "the real server does not offer";
  return new ProtocolError(
    MOCK_ERROR_CODES.methodUnavailable,
    `${method} is not available: ${who} ${family}.`,
    {
      mockCode: "mock_method_unavailable",
      method,
      side,
    }
  );
}

export function toolNotFoundError(name: string): ProtocolError {
  return new ProtocolError(
    MOCK_ERROR_CODES.toolNotFound,
    `Tool ${name} not found`,
    {
      mockCode: "mock_tool_not_found",
      tool: name,
    }
  );
}

export function realUnreachableError(cause: unknown): ProtocolError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new ProtocolError(
    MOCK_ERROR_CODES.realUnreachable,
    `The mock could not reach the real server: ${detail}. Check that the server is up, then try again.`,
    {
      mockCode: "mock_real_unreachable",
    }
  );
}
