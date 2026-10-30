import type { MCPClientManager } from "@mcpjam/sdk";
import { getManagerConnections } from "./mcp-connections.js";
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";

/** Resolve a saved account pin without substituting the current default. */
export function taskConnectionKey(
  manager: MCPClientManager,
  target: {
    serverId?: string;
    connectionId?: string;
    wire?: "legacy" | "extension";
  },
): string {
  if (
    typeof target.serverId !== "string" ||
    !target.serverId ||
    (target.connectionId !== undefined &&
      (typeof target.connectionId !== "string" ||
        !target.connectionId ||
        target.connectionId.includes("\u0000"))) ||
    (target.wire !== undefined &&
      target.wire !== "legacy" &&
      target.wire !== "extension")
  ) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Invalid task target",
    );
  }
  let key = target.serverId;
  if (target.connectionId !== undefined) {
    const connection = getManagerConnections(manager)?.[target.serverId]?.find(
      (candidate) => candidate.connectionId === target.connectionId,
    );
    if (!connection) {
      throw new WebRouteError(
        403,
        ErrorCode.FORBIDDEN,
        "The account saved with this task is unavailable. Reconnect that account to continue.",
      );
    }
    key = connection.key;
  }
  if (
    target.wire !== undefined &&
    manager.getTasksSupport(key).wire !== target.wire
  ) {
    throw new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      "This task uses a different MCP version. Restore the server's protocol settings to continue.",
    );
  }
  return key;
}
