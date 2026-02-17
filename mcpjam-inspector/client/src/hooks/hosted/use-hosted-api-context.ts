import { useEffect } from "react";
import { HOSTED_MODE } from "@/lib/config";
import { setHostedApiContext } from "@/lib/apis/web/context";

interface UseHostedApiContextOptions {
  workspaceId: string | null;
  serverIdsByName: Record<string, string>;
  getAccessToken: () => Promise<string | undefined | null>;
}

export function useHostedApiContext({
  workspaceId,
  serverIdsByName,
  getAccessToken,
}: UseHostedApiContextOptions): void {
  useEffect(() => {
    if (!HOSTED_MODE) {
      setHostedApiContext(null);
      return;
    }

    setHostedApiContext({
      workspaceId,
      serverIdsByName,
      getAccessToken,
    });

    return () => {
      setHostedApiContext(null);
    };
  }, [workspaceId, serverIdsByName, getAccessToken]);
}
