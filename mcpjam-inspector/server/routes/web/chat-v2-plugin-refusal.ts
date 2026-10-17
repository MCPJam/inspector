import { describePluginError } from "@/shared/plugin-diagnostics";
import { PluginModelContextError } from "@/shared/plugin-model-context";
import { PluginWorkspaceAdmissionError } from "../../services/plugin-host/admission.js";
import { PluginInvocationError } from "../../services/plugin-host/invocation.js";
import { ErrorCode } from "./errors.js";

/**
 * A chat turn refused by the plugin workspace, as the response it gets: its
 * own status, a plain description and the stable code (for Logs). As a
 * generic 500 it read "execution is unavailable for this project" even when
 * MCPJam simply couldn't reach its backend.
 */
export function pluginChatRefusal(error: unknown):
  | {
      status: number;
      code: ErrorCode;
      message: string;
      details: { pluginCode: string };
    }
  | undefined {
  // The Apps' context is over the client's turn budget: the person can fix
  // it by removing context, so it is a refused request, not an MCPJam fault.
  if (error instanceof PluginModelContextError)
    return {
      status: 413,
      code: ErrorCode.VALIDATION_ERROR,
      message: describePluginError(error.message) ?? error.message,
      details: { pluginCode: error.message },
    };
  if (
    !(error instanceof PluginWorkspaceAdmissionError) &&
    !(error instanceof PluginInvocationError)
  )
    return undefined;
  const status =
    error instanceof PluginWorkspaceAdmissionError
      ? error.status
      : error.outcomeUnknown
        ? 409
        : 403;
  return {
    status,
    // FORBIDDEN and INTERNAL_ERROR keep the message as written; the chat
    // rewrites SERVER_UNREACHABLE/TIMEOUT as the user's MCP server failing.
    code: status === 403 ? ErrorCode.FORBIDDEN : ErrorCode.INTERNAL_ERROR,
    message: describePluginError(error.code) ?? error.message,
    details: { pluginCode: error.code },
  };
}
