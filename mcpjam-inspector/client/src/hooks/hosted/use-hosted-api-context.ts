import { useLayoutEffect } from "react";
import { HOSTED_MODE } from "@/lib/config";
import { setHostedApiContext } from "@/lib/apis/web/context";

interface UseHostedApiContextOptions {
  projectId: string | null;
  serverIdsByName: Record<string, string>;
  clientCapabilities?: Record<string, unknown>;
  clientConfigSyncPending?: boolean;
  getAccessToken: () => Promise<string | undefined | null>;
  oauthTokensByServerId?: Record<string, string>;
  guestOauthTokensByServerName?: Record<string, string>;
  chatboxToken?: string;
  isAuthenticated?: boolean;
  /** Maps server name → MCPServerConfig for guest mode (no Convex). */
  serverConfigs?: Record<string, unknown>;
  enabled?: boolean;
}

export function useHostedApiContext({
  projectId,
  serverIdsByName,
  clientCapabilities,
  clientConfigSyncPending,
  getAccessToken,
  oauthTokensByServerId,
  guestOauthTokensByServerName,
  chatboxToken,
  isAuthenticated,
  serverConfigs,
  enabled = true,
}: UseHostedApiContextOptions): void {
  // useLayoutEffect so the global hosted context is set synchronously before
  // any child useEffect hooks fire (e.g. fetchToolsMetadata in useChatSession).
  // With useEffect, React's bottom-up ordering means child passive effects run
  // between this effect's cleanup (which nulls the context) and its setup,
  // causing "Hosted server not found" errors for shared-chat OAuth servers.
  useLayoutEffect(() => {
    if (!HOSTED_MODE) {
      setHostedApiContext(null);
      return;
    }

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
      guestOauthTokensByServerName,
      chatboxToken,
      isAuthenticated,
      serverConfigs,
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
    guestOauthTokensByServerName,
    chatboxToken,
    isAuthenticated,
    serverConfigs,
  ]);
}
