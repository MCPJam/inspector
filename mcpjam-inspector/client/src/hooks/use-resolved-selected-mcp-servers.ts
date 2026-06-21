import { useMemo } from "react";
import { useConvexAuth } from "convex/react";
import { useProjectServers } from "@/hooks/useViews";
import { useOptionalSharedAppState } from "@/state/app-state-context";
import { buildOAuthTokensByServerId } from "@/lib/oauth/oauth-tokens";

export interface UseResolvedSelectedMcpServersArgs {
  projectId: string | null | undefined;
  /**
   * Optional surface-owned selected names. Chat and Playground pass their
   * already-filtered runtime selection here. When omitted, the hook derives the
   * Home/agent selection from shared app state.
   */
  selectedServerNames?: readonly string[] | null;
}

export interface ResolvedSelectedMcpServers {
  selectedServerIds: string[];
  selectedServerNames: string[];
  oauthTokens: Record<string, string> | undefined;
  serversById: Map<string, string>;
  serversByName: Map<string, string>;
  isLoading: boolean;
  isReady: boolean;
}

export function useResolvedSelectedMcpServers({
  projectId,
  selectedServerNames,
}: UseResolvedSelectedMcpServersArgs): ResolvedSelectedMcpServers {
  const { isAuthenticated } = useConvexAuth();
  const { serversById, serversByName, isLoading } = useProjectServers({
    isAuthenticated,
    projectId: projectId ?? null,
  });
  const appState = useOptionalSharedAppState();

  const effectiveSelectedServerNames = useMemo(() => {
    if (selectedServerNames) {
      return [...selectedServerNames];
    }

    const serverMap = appState?.servers ?? {};
    const activeSelectedNames = (appState?.selectedMultipleServers ?? []).filter(
      (name) => {
        const status = serverMap[name]?.connectionStatus;
        return status === "connected" || status === "connecting";
      }
    );
    if (activeSelectedNames.length > 0) return activeSelectedNames;

    return Object.entries(serverMap)
      .filter(([, server]) => server?.connectionStatus === "connected")
      .map(([name]) => name);
  }, [
    appState?.selectedMultipleServers,
    appState?.servers,
    selectedServerNames,
  ]);

  const selectedServers = useMemo(() => {
    const serverMap = appState?.servers ?? {};
    const ids: string[] = [];
    const names: string[] = [];

    for (const name of effectiveSelectedServerNames) {
      const id = serversByName.get(name);
      if (!id) continue;
      ids.push(id);
      names.push(name);
    }

    const oauthTokens = buildOAuthTokensByServerId(
      names,
      (name) => serversByName.get(name),
      (name) => serverMap[name]?.oauthTokens?.access_token
    );

    return { ids, names, oauthTokens };
  }, [appState?.servers, effectiveSelectedServerNames, serversByName]);

  return {
    selectedServerIds: selectedServers.ids,
    selectedServerNames: selectedServers.names,
    oauthTokens: selectedServers.oauthTokens,
    serversById,
    serversByName,
    isLoading,
    isReady: !isLoading,
  };
}
