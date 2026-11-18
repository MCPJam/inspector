import type { MCPClientManager } from "@mcpjam/sdk";
import { captureAccountProfile } from "./account-profile-capture.js";
import { getManagerConnections } from "./mcp-connections.js";

/** Best-effort session-start refresh. Identity writes remain generation-bound. */
export async function refreshConnectionProfiles(
  manager: MCPClientManager,
  bearer: string,
  projectId: string,
) {
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
