import type { MCPClientManager } from "@mcpjam/sdk";
import {
  getManagerConnections,
  getManagerTaskOwnerScope,
  localConnectionKeysForServer,
} from "./mcp-connections.js";
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";

/** Resolve a saved account pin without substituting the current default. */
export function taskConnectionKey(
  manager: MCPClientManager,
  target: {
    serverId?: string;
    connectionId?: string;
    wire?: "legacy" | "extension";
    ownerScope?: string;
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
  const groups = getManagerConnections(manager) ?? {};
  const localKeys = localConnectionKeysForServer(manager, target.serverId);
  let key = localKeys.length === 1 ? localKeys[0] : target.serverId;
  if (
    target.ownerScope &&
    target.connectionId === undefined &&
    localKeys.length > 1
  ) {
    throw new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      "More than one local connection matches this task. Reconnect its server to continue.",
    );
  }
  if (target.connectionId !== undefined) {
    const direct = groups[target.serverId] ?? groups[key] ?? [];
    const matches = Object.values(groups)
      .flat()
      .filter(
        (candidate) =>
          candidate.connectionId === target.connectionId &&
          (candidate.serverId === target.serverId ||
            direct.includes(candidate)),
      );
    if (matches.length !== 1) {
      throw new WebRouteError(
        403,
        ErrorCode.FORBIDDEN,
        "The account saved with this task is unavailable. Reconnect that account to continue.",
      );
    }
    key = matches[0].key;
  }
  if (
    target.ownerScope !== undefined &&
    getManagerTaskOwnerScope(manager, key) !== target.ownerScope
  ) {
    throw new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      "This task's saved user or project does not match the current session. Open it in its original MCPJam account and project.",
    );
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
