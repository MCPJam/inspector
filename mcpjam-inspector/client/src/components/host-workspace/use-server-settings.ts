import { useEffect, useState } from "react";
import { createServerSettingsApi } from "./server-settings-api";
import type { ThreadAppScope } from "./thread-app-api";

/** Discovery is metadata-only; opening settings is a separate explicit action. */
export function useServerSettingsAvailability(
  scope: ThreadAppScope | null,
  serverId: string | null,
) {
  const key =
    scope && serverId
      ? JSON.stringify([
          scope.projectId,
          scope.hostId,
          scope.pluginWorkspace.workspaceId,
          serverId,
        ])
      : null;
  const [state, setState] = useState<{
    key: string | null;
    available: boolean;
    failed: boolean;
  }>({ key: null, available: false, failed: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!scope || !serverId || !key) return;
    const abort = new AbortController();
    void createServerSettingsApi(scope, serverId, async () => false)
      .discover(abort.signal)
      .then(
        (available) => {
          if (!abort.signal.aborted)
            setState({ key, available, failed: false });
        },
        () => {
          if (!abort.signal.aborted)
            setState({ key, available: false, failed: true });
        },
      );
    return () => abort.abort();
  }, [key, attempt]);
  const current = state.key === key;
  return {
    available: !!key && current && state.available,
    failed: !!key && current && state.failed,
    loading: !!key && !current,
    retry: () => setAttempt((n) => n + 1),
  };
}
