import { useCallback, useEffect, useState } from "react";
import {
  listOAuthConnections,
  OAUTH_CONNECTIONS_CHANGED,
} from "@/lib/apis/web/oauth-connections";
import type { OAuthConnection } from "@/shared/oauth-connections";
export function useHostedOAuthConnections(
  projectId?: string | null,
  serverId?: string | null,
  enabled = true,
) {
  const [list, setList] = useState<{
    key: string;
    connections: OAuthConnection[];
    shared: boolean;
  }>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const refetch = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    window.addEventListener(OAUTH_CONNECTIONS_CHANGED, refetch);
    return () => window.removeEventListener(OAUTH_CONNECTIONS_CHANGED, refetch);
  }, [refetch]);
  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    if (enabled && projectId && serverId)
      void listOAuthConnections(projectId, serverId)
        .then((rows) => {
          if (!cancelled) setList({ key: `${projectId}/${serverId}`, ...rows });
        })
        .catch((e) => {
          if (!cancelled)
            setError(
              e instanceof Error ? e.message : "Could not load accounts",
            );
        });
    return () => {
      cancelled = true;
    };
  }, [projectId, serverId, enabled, revision]);
  // A refetch keeps the current rows on screen until the new ones land, so
  // nothing that depends on them blinks; another server's rows never show.
  const current =
    enabled && list?.key === `${projectId}/${serverId}` ? list : undefined;
  return {
    connections: current?.connections ?? [],
    // Until the list answers, a server counts as shared, which hides adding
    // an account that the server's mode may not allow.
    shared: current?.shared ?? true,
    loaded: current !== undefined,
    error,
    refetch,
  };
}
