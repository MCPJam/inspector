import { useClientConfigStore } from "@/stores/client-config-store";
import { useHostContextStore } from "@/stores/host-context-store";

export function useProjectClientConfigSyncPending(
  projectId: string | null | undefined,
) {
  const connectionSyncPending = useClientConfigStore(
    (state) =>
      state.isAwaitingRemoteEcho && state.pendingProjectId === projectId,
  );
  const hostContextSyncPending = useHostContextStore(
    (state) =>
      state.isAwaitingRemoteEcho && state.pendingProjectId === projectId,
  );

  return connectionSyncPending || hostContextSyncPending;
}
