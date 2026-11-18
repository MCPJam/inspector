import type { MCPClientManager } from "@mcpjam/sdk";
import { captureAccountProfile } from "./account-profile-capture.js";
import { getManagerConnections } from "./mcp-connections.js";

/**
 * Best-effort session-start refresh. Identity writes remain generation-bound.
 *
 * Asking who an account is calls the server's profile tool, and MCP expects a
 * host to get consent before it invokes a tool. With tool approval on for the
 * turn, nobody has agreed to that call, so it is not made: the accounts keep
 * the identity already recorded, and eval runs fall back to the token's
 * claims.
 */
export async function refreshConnectionProfiles(
  manager: MCPClientManager,
  bearer: string,
  projectId: string,
  options: { toolApprovalRequired: boolean },
) {
  if (options.toolApprovalRequired) return;
  const groups = Object.values(getManagerConnections(manager) ?? {}).filter(
    (group) => group.length >= 2,
  );
  await Promise.allSettled(
    groups.flatMap((group) =>
      group.map((connection) =>
        captureAccountProfile(manager, connection, { bearer, projectId }),
      ),
    ),
  );
}
