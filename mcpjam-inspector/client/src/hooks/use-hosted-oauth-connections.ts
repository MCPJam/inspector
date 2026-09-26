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
  const [connections, setConnections] = useState<OAuthConnection[]>([]);
  const [shared, setShared] = useState(true);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const refetch = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    window.addEventListener(OAUTH_CONNECTIONS_CHANGED, refetch);
    return () => window.removeEventListener(OAUTH_CONNECTIONS_CHANGED, refetch);
  }, [refetch]);
  useEffect(() => {
    let cancelled = false;
    setConnections([]);
    setError(undefined);
    if (enabled && projectId && serverId)
      void listOAuthConnections(projectId, serverId)
        .then((rows) => {
          if (!cancelled) {
            setConnections(rows.connections);
            setShared(rows.shared);
          }
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
  return { connections, shared, error, refetch };
}
