import { useMemo } from "react";
import { useSharedAppState } from "@/state/app-state-context";
import { useWorkspaceMembers } from "@/hooks/useWorkspaces";
import { useAvailableEvalModels } from "@/hooks/use-available-eval-models";

export function useEvalTabContext({
  isAuthenticated,
  workspaceId,
  isDirectGuest = false,
}: {
  isAuthenticated: boolean;
  workspaceId: string | null;
  /**
   * Present so callers can thread guest context; not consumed here — Convex
   * mutations enforce guest policy server-side via the foundation actor helper.
   */
  isDirectGuest?: boolean;
}) {
  void isDirectGuest;
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

  // Suite visibility already implies suite access; let the backend mutation
  // remain the source of truth for whether deletion is allowed.
  const canDeleteSuite = true;
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
    canDeleteSuite,
    canDeleteRuns,
    availableModels,
  };
}
