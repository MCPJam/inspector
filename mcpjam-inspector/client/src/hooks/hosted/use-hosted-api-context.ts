import { useLayoutEffect } from "react";
import { HOSTED_MODE } from "@/lib/config";
import { setHostedApiContext } from "@/lib/apis/web/context";

interface UseHostedApiContextOptions {
  workspaceId: string | null;
  serverIdsByName: Record<string, string>;
  getAccessToken: () => Promise<string | undefined | null>;
  oauthTokensByServerId?: Record<string, string>;
  guestOauthTokensByServerName?: Record<string, string>;
  shareToken?: string;
  sandboxToken?: string;
  isAuthenticated?: boolean;
  /** True when a WorkOS session exists, even if the token hasn't resolved yet. */
  hasSession?: boolean;
  /** Maps server name → MCPServerConfig for guest mode (no Convex). */
  serverConfigs?: Record<string, unknown>;
  enabled?: boolean;
}

export function useHostedApiContext({
  workspaceId,
  serverIdsByName,
  getAccessToken,
  oauthTokensByServerId,
  guestOauthTokensByServerName,
  shareToken,
  sandboxToken,
  isAuthenticated,
  hasSession,
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
      workspaceId,
      serverIdsByName,
      getAccessToken,
      oauthTokensByServerId,
      guestOauthTokensByServerName,
      shareToken,
      sandboxToken,
      isAuthenticated,
      hasSession,
      serverConfigs,
    });

    return () => {
      setHostedApiContext(null);
    };
  }, [
    enabled,
    workspaceId,
    serverIdsByName,
    getAccessToken,
    oauthTokensByServerId,
    guestOauthTokensByServerName,
    shareToken,
    sandboxToken,
    isAuthenticated,
    hasSession,
    serverConfigs,
  ]);
}
