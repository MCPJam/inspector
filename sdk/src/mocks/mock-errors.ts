import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { MockBindingIssue } from "./bindings.js";
import type { MockForwardBlockReason } from "./mock-observer.js";

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
  /** A forward the host refused: the policy, the caller's access, or a failed policy check. */
  forwardBlocked: -32013,
  /** A method one side lacks (JSON-RPC method not found). */
  methodUnavailable: ProtocolErrorCode.MethodNotFound,
  /** `tools/call` for a name the mock does not list (JSON-RPC invalid params). */
  toolNotFound: ProtocolErrorCode.InvalidParams,
  /** `prompts/get` for a prompt the mock does not list (JSON-RPC invalid params). */
  promptNotFound: ProtocolErrorCode.InvalidParams,
  /**
   * `resources/read` for a resource the mock does not serve. 2026-07-28 moved
   * this from -32002 to invalid params (SEP-2164); the server SDK maps a thrown
   * -32002 to -32602 on every revision, so the mock states the new code.
   */
  resourceNotFound: ProtocolErrorCode.InvalidParams,
} as const;

export interface MissingEditedTool {
  /** The name the definition gives the entry. */
  tool: string;
  /** The real tool the entry points at. */
  realTool: string;
}

/**
 * An override the real server no longer fits. It names each override by its
 * path in the definition so the author can repair exactly that, and it never
 * picks a new target on the author's behalf.
 */
export function bindingError(issues: MockBindingIssue[]): ProtocolError {
  const missingOnly = issues.every((issue) => issue.code === "target_missing");
  const paths = issues.map((issue) => issue.path).join(", ");
  const these = issues.length === 1 ? "that override" : "those overrides";
  let message: string;
  if (missingOnly) {
    const names = issues.map((issue) =>
      issue.tool === issue.realTool
        ? `"${issue.tool}"`
        : `"${issue.tool}" (real tool "${issue.realTool}")`
    );
    message = `The mock edits ${names.join(", ")}, which the real server no longer lists. Update ${paths} to drop or retarget ${these}.`;
  } else {
    const what = issues.map((issue) => `${issue.path}: ${issue.message}`);
    message = `The mock's overrides no longer fit the real server. ${what.join(" ")} Update ${paths} to repair ${these}.`;
  }
  const tools = [
    ...new Map(
      issues.map((issue) => [issue.tool, { tool: issue.tool, realTool: issue.realTool }])
    ).values(),
  ];
  return new ProtocolError(MOCK_ERROR_CODES.editedToolMissing, message, {
    mockCode: missingOnly ? "mock_edited_tool_missing" : "mock_binding_invalid",
    tools,
    issues,
  });
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

/** A method no side of the mock serves: JSON-RPC method not found, not an internal error. */
/** A page cursor the mock did not issue, or one from before the list changed. */
export function invalidMockCursorError(): ProtocolError {
  return new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    "That page cursor is not valid for this mock. List again without a cursor.",
    { mockCode: "mock_invalid_cursor" }
  );
}

export function unknownMethodError(method: string): ProtocolError {
  return new ProtocolError(
    MOCK_ERROR_CODES.methodUnavailable,
    `Method not found: ${method}`,
    { mockCode: "mock_method_unavailable", method }
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

/** Whether `error` is the mock's report that the real server could not be reached. */
export function isRealUnreachable(error: unknown): error is ProtocolError {
  return (
    error instanceof ProtocolError &&
    error.code === MOCK_ERROR_CODES.realUnreachable
  );
}

/** A forward the host refused (`forwardBlockedError`). */
export function isForwardBlocked(error: unknown): error is ProtocolError {
  return (
    error instanceof ProtocolError &&
    error.code === MOCK_ERROR_CODES.forwardBlocked
  );
}

/** A request the mock would pass to the real server, refused before dispatch. */
export function forwardBlockedError(
  method: string,
  reason: MockForwardBlockReason,
  message: string
): ProtocolError {
  return new ProtocolError(MOCK_ERROR_CODES.forwardBlocked, message, {
    mockCode: "mock_forward_blocked",
    method,
    reason,
  });
}

export type MockItemKind = "prompt" | "resource" | "resource template";

/** A list: the definition edits something the real server no longer lists. */
export function editedItemMissingError(
  kind: MockItemKind,
  keys: string[]
): ProtocolError {
  const names = keys.map((key) => `"${key}"`).join(", ");
  return new ProtocolError(
    MOCK_ERROR_CODES.editedToolMissing,
    `The mock edits the ${kind}${keys.length === 1 ? "" : "s"} ${names}, which the real server no longer lists. Update the mock to drop ${keys.length === 1 ? "that edit" : "those edits"}.`,
    { mockCode: "mock_edited_item_missing", kind, items: keys }
  );
}

export function promptNotFoundError(name: string): ProtocolError {
  return new ProtocolError(
    MOCK_ERROR_CODES.promptNotFound,
    `Prompt ${name} not found`,
    { mockCode: "mock_prompt_not_found", prompt: name }
  );
}

export function resourceNotFoundError(uri: string): ProtocolError {
  return new ProtocolError(
    MOCK_ERROR_CODES.resourceNotFound,
    `Resource ${uri} not found`,
    { mockCode: "mock_resource_not_found", uri }
  );
}
