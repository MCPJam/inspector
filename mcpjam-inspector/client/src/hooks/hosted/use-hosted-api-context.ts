import { useEffect } from "react";
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
  useEffect(() => {
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
