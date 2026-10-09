import { captureOpenAIProfile, type MCPClientManager } from "@mcpjam/sdk";
import { getManagerConnections } from "./mcp-connections.js";

/** Best-effort session-start refresh. Identity writes remain generation-bound. */
export async function refreshConnectionProfiles(
  manager: MCPClientManager,
  bearer: string,
  projectId: string,
) {
  const url = process.env.CONVEX_HTTP_URL;
  if (!url) return;
  const groups = Object.values(getManagerConnections(manager) ?? {}).filter(
    (group) => group.length >= 2,
  );
  await Promise.allSettled(
    groups.flatMap((group) =>
      group.map(async (connection) => {
        const signal = AbortSignal.timeout(3_000);
        const started = Date.now();
        const post = (operation: string, body: unknown) =>
          fetch(`${url}/web/oauth/connections/${operation}`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${bearer}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal,
          });
        const base = {
          projectId,
          serverId: connection.serverId,
          connectionId: connection.connectionId,
        };
        const contextResponse = await post("capture-context", base);
        if (!contextResponse.ok) return;
        const context = await contextResponse.json();
        if (!context.expectedVaultObjectId || signal.aborted) return;
        const captured = await captureOpenAIProfile(manager, connection.key, {
          timeoutMs: Math.max(1, 3_000 - (Date.now() - started)),
        });
        if (
          !captured.profile ||
          signal.aborted ||
          (["id", "name", "email", "nickname"] as const).every(
            (field) => captured.profile?.[field] === context.profile?.[field],
          )
        )
          return;
        await post("profile", {
          ...base,
          profile: captured.profile,
          expectedVaultObjectId: context.expectedVaultObjectId,
        });
      }),
    ),
  );
}
