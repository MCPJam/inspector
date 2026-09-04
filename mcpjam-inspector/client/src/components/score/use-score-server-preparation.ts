import { useCallback } from "react";
import { useMutation } from "convex/react";
import { tryResolveProjectServer } from "@/lib/apis/web/context";
import type { ServerWithName } from "@/state/app-types";
import { deriveScoreServerName } from "./score-server-name";

const SERVER_ID_ATTEMPTS = 60;
const SERVER_ID_RETRY_MS = 250;

async function waitForServerId(serverName: string): Promise<string> {
  for (let attempt = 0; attempt < SERVER_ID_ATTEMPTS; attempt++) {
    const serverId = tryResolveProjectServer(serverName)?.serverId;
    if (serverId) return serverId;
    await new Promise((resolve) => setTimeout(resolve, SERVER_ID_RETRY_MS));
  }

  throw new Error(
    "Timed out preparing the workspace for this server. Reload and try again.",
  );
}

function createDisconnectedServer(name: string, url: string): ServerWithName {
  return {
    name,
    config: { url } as ServerWithName["config"],
    lastConnectionTime: new Date(),
    connectionStatus: "disconnected",
    retryCount: 0,
  };
}

export interface PreparedScoreServer {
  name: string;
  server: ServerWithName;
}

export function useScoreServerPreparation(projectId: string | null) {
  const createServerIfMissing = useMutation(
    "servers:createServerIfMissing" as any,
  );
  const updateServer = useMutation("servers:updateServer" as any);

  return useCallback(
    async (serverUrl: string): Promise<PreparedScoreServer> => {
      if (!projectId) {
        throw new Error(
          "Still setting up your workspace. Give it a moment and try again.",
        );
      }

      const name = await deriveScoreServerName(serverUrl);
      await createServerIfMissing({
        projectId,
        name,
        enabled: true,
        transportType: "http",
        url: serverUrl,
        // Discovery is required to distinguish an OAuth challenge from a
        // generic transport failure for a URL supplied by a visitor.
        authMethod: "auto",
      } as any);

      const serverId = await waitForServerId(name);
      try {
        // Old rows may predate auth discovery. Reconcile them without making a
        // best-effort migration failure abort an otherwise valid scan.
        await updateServer({ serverId, authMethod: "auto" } as any);
      } catch {
        // A newly created row already has the correct mode.
      }

      return { name, server: createDisconnectedServer(name, serverUrl) };
    },
    [createServerIfMissing, projectId, updateServer],
  );
}
