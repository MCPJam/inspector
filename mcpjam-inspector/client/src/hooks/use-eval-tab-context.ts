import { useMemo } from "react";
import { useSharedAppState } from "@/state/app-state-context";
import { useWorkspaceMembers } from "@/hooks/useWorkspaces";
import { useAvailableEvalModels } from "@/hooks/use-available-eval-models";

export function useEvalTabContext({
  isAuthenticated,
  workspaceId,
}: {
  isAuthenticated: boolean;
  workspaceId: string | null;
}) {
  const appState = useSharedAppState();
  const { availableModels } = useAvailableEvalModels();
  const { members, canManageMembers } = useWorkspaceMembers({
    isAuthenticated,
    workspaceId,
  });

  const connectedServerNames = useMemo(
    () =>
      new Set(
        Object.entries(appState.servers)
          .filter(([, server]) => server.connectionStatus === "connected")
          .map(([name]) => name),
      ),
    [appState.servers],
  );

  const canDeleteRuns = !workspaceId || canManageMembers;

  const userMap = useMemo(() => {
    if (!members) return undefined;
    const map = new Map<string, { name: string; imageUrl?: string }>();
    for (const member of members) {
      if (member.userId && member.user) {
        map.set(member.userId, {
          name: member.user.name,
          imageUrl: member.user.imageUrl,
        });
      }
    }
    return map;
  }, [members]);

  return {
    connectedServerNames,
    userMap,
    canDeleteRuns,
    availableModels,
  };
}
