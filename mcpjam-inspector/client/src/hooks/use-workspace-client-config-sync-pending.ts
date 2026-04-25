import { useClientConfigStore } from "@/stores/client-config-store";
import { useHostContextStore } from "@/stores/host-context-store";

export function useWorkspaceClientConfigSyncPending(
  workspaceId: string | null | undefined,
) {
  const connectionSyncPending = useClientConfigStore(
    (state) =>
      state.isAwaitingRemoteEcho && state.pendingWorkspaceId === workspaceId,
  );
  const hostContextSyncPending = useHostContextStore(
    (state) =>
      state.isAwaitingRemoteEcho && state.pendingWorkspaceId === workspaceId,
  );

  return connectionSyncPending || hostContextSyncPending;
}
