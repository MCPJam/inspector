import { useEffect, useState } from "react";
import { createServerSettingsApi } from "./server-settings-api";
import type { ThreadAppScope } from "./thread-app-api";
import {
  describePluginSettingsError,
  pluginSettingsErrorCode,
} from "./plugin-settings-errors";
import { logPluginExtensionIssue } from "@/lib/plugin-extension-logs";

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
    errorCode?: string;
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
        (error: unknown) => {
          if (abort.signal.aborted) return;
          const errorCode = pluginSettingsErrorCode(error);
          logPluginExtensionIssue({
            code: errorCode ?? "PLUGIN_SETTINGS_FAILED",
            message: describePluginSettingsError(errorCode),
            serverId,
            detail: { step: "discover" },
            dedupeKey: `settings:${serverId}:discover:${errorCode ?? "unknown"}`,
          });
          setState({ key, available: false, failed: true, errorCode });
        },
      );
    return () => abort.abort();
  }, [key, attempt]);
  const current = state.key === key;
  return {
    available: !!key && current && state.available,
    failed: !!key && current && state.failed,
    errorMessage:
      current && state.failed
        ? describePluginSettingsError(state.errorCode)
        : undefined,
    loading: !!key && !current,
    retry: () => setAttempt((n) => n + 1),
  };
}
