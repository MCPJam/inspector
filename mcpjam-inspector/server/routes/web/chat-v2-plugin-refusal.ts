import { describePluginError } from "@/shared/plugin-diagnostics";
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
