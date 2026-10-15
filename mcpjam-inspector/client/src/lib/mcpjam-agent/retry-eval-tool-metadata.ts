import type { ServerActions } from "@/state/server-actions-context";
import {
  loadEvalToolMetadata,
  readEvalToolMetadata,
  type EvalToolMetadata,
  type MetadataTarget,
} from "./eval-tool-metadata";

export async function retryEvalToolMetadata({
  target,
  load,
  ensureServersReady,
  resolveName,
  serverId,
}: {
  target: MetadataTarget;
  load: (id: string) => Promise<{ tools?: EvalToolMetadata[] }>;
  ensureServersReady?: ServerActions["ensureServersReady"];
  resolveName: (id: string) => string;
  serverId?: string;
}) {
  const ids = serverId ? [serverId] : target.serverIds;
  const failed = readEvalToolMetadata(target).servers.filter(
    (server) => ids.includes(server.serverId) && server.action === "reconnect",
  );
  const unauthorized: string[] = [];
  for (const server of failed) {
    const name = resolveName(server.serverId);
    const result = await ensureServersReady?.([name], {
      allowInteractiveOAuthFlow: true,
      forceReconnect: true,
    });
    if (!result?.readyServerNames.includes(name))
      unauthorized.push(server.serverId);
  }
  await loadEvalToolMetadata(
    {
      ...target,
      serverIds: ids.filter((id) => !unauthorized.includes(id)),
    },
    load,
    true,
  );
  if (unauthorized.length)
    throw new Error(
      "Server authorization is required. Open Servers to check its authentication settings and retry.",
    );
}
