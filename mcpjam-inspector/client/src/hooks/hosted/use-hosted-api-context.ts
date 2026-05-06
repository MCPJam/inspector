import { useLayoutEffect } from "react";
import { setHostedApiContext } from "@/lib/apis/web/context";

interface UseHostedApiContextOptions {
  projectId: string | null;
  serverIdsByName: Record<string, string>;
  clientCapabilities?: Record<string, unknown>;
  clientConfigSyncPending?: boolean;
  getAccessToken: () => Promise<string | undefined | null>;
  oauthTokensByServerId?: Record<string, string>;
  shareToken?: string;
  chatboxToken?: string;
  isAuthenticated?: boolean;
  hasSession?: boolean;
  enabled?: boolean;
}

export function useHostedApiContext({
  projectId,
  serverIdsByName,
  clientCapabilities,
  clientConfigSyncPending,
  getAccessToken,
  oauthTokensByServerId,
  shareToken,
  chatboxToken,
  isAuthenticated,
  hasSession,
  enabled = true,
}: UseHostedApiContextOptions): void {
  // useLayoutEffect so the global hosted context is set synchronously before
  // any child useEffect hooks fire (e.g. fetchToolsMetadata in useChatSession).
  // With useEffect, React's bottom-up ordering means child passive effects run
  // between this effect's cleanup (which nulls the context) and its setup,
  // causing "Hosted server not found" errors for shared-chat OAuth servers.
  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }

    setHostedApiContext({
      projectId,
      serverIdsByName,
      clientCapabilities,
      clientConfigSyncPending,
      getAccessToken,
      oauthTokensByServerId,
      shareToken,
      chatboxToken,
      isAuthenticated,
      hasSession,
    });

    return () => {
      setHostedApiContext(null);
    };
  }, [
    enabled,
    projectId,
    serverIdsByName,
    clientCapabilities,
    clientConfigSyncPending,
    getAccessToken,
    oauthTokensByServerId,
    shareToken,
    chatboxToken,
    isAuthenticated,
    hasSession,
  ]);
}
