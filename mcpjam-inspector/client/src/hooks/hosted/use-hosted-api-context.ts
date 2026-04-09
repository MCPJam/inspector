import { useLayoutEffect, useRef } from "react";
import { HOSTED_MODE } from "@/lib/config";
import { setHostedApiContext } from "@/lib/apis/web/context";
import { clearGuestSession } from "@/lib/guest-session";

interface UseHostedApiContextOptions {
  workspaceId: string | null;
  serverIdsByName: Record<string, string>;
  clientCapabilities?: Record<string, unknown>;
  clientConfigSyncPending?: boolean;
  getAccessToken: () => Promise<string | undefined | null>;
  oauthTokensByServerId?: Record<string, string>;
  guestOauthTokensByServerName?: Record<string, string>;
  shareToken?: string;
  sandboxToken?: string;
  isAuthenticated?: boolean;
  /** Maps server name → MCPServerConfig for guest mode (no Convex). */
  serverConfigs?: Record<string, unknown>;
  enabled?: boolean;
}

export function useHostedApiContext({
  workspaceId,
  serverIdsByName,
  clientCapabilities,
  clientConfigSyncPending,
  getAccessToken,
  oauthTokensByServerId,
  guestOauthTokensByServerName,
  shareToken,
  sandboxToken,
  isAuthenticated,
  serverConfigs,
  enabled = true,
}: UseHostedApiContextOptions): void {
  // Track previous isAuthenticated to detect false→true transitions.
  // When a guest signs in, clear the stale guest session from localStorage
  // so no code path can accidentally reuse an expired guest bearer.
  const prevAuthenticatedRef = useRef(isAuthenticated);
  useLayoutEffect(() => {
    const wasAuthenticated = prevAuthenticatedRef.current;
    prevAuthenticatedRef.current = isAuthenticated;
    if (!wasAuthenticated && isAuthenticated) {
      clearGuestSession();
    }
  }, [isAuthenticated]);

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
      clientCapabilities,
      clientConfigSyncPending,
      getAccessToken,
      oauthTokensByServerId,
      guestOauthTokensByServerName,
      shareToken,
      sandboxToken,
      isAuthenticated,
      serverConfigs,
    });

    return () => {
      setHostedApiContext(null);
    };
  }, [
    enabled,
    workspaceId,
    serverIdsByName,
    clientCapabilities,
    clientConfigSyncPending,
    getAccessToken,
    oauthTokensByServerId,
    guestOauthTokensByServerName,
    shareToken,
    sandboxToken,
    isAuthenticated,
    serverConfigs,
  ]);
}
