import { useLayoutEffect } from "react";
import { HOSTED_MODE } from "@/lib/config";
import { setHostedApiContext } from "@/lib/apis/web/context";

interface UseHostedApiContextOptions {
  workspaceId: string | null;
  serverIdsByName: Record<string, string>;
  getAccessToken: () => Promise<string | undefined | null>;
  oauthTokensByServerId?: Record<string, string>;
  shareToken?: string;
  enabled?: boolean;
}

export function useHostedApiContext({
  workspaceId,
  serverIdsByName,
  getAccessToken,
  oauthTokensByServerId,
  shareToken,
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
      shareToken,
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
    shareToken,
  ]);
}
