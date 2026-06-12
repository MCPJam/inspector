import { useMemo } from "react";
import { useSharedAppState } from "@/state/app-state-context";
import { findProjectByAnyId } from "@/state/app-types";
import { useProjectMembers } from "@/hooks/useProjects";
import { useAvailableModels } from "@/hooks/use-available-models";

export function useEvalTabContext({
  isAuthenticated,
  projectId,
  isDirectGuest = false,
}: {
  isAuthenticated: boolean;
  projectId: string | null;
  /**
   * Present so callers can thread guest context; not consumed here — Convex
   * mutations enforce guest policy server-side via the foundation actor helper.
   */
  isDirectGuest?: boolean;
}) {
  void isDirectGuest;
  const appState = useSharedAppState();
  // Scope to the requested project so model availability follows that project's
  // org rather than whatever happens to be the globally-active project.
  // Callers pass the Convex/shared project id (App.tsx's convexProjectId),
  // so resolve across both id spaces. (`useAvailableModels` does the same
  // internally and falls back to the active project when null.)
  const scopedProjectId = projectId ?? appState.activeProjectId ?? null;
  const scopedProject = findProjectByAnyId(appState.projects, scopedProjectId);
  // Still returned to callers; the models hook re-derives it internally.
  const organizationId = scopedProject?.organizationId ?? null;
  const { availableModels } = useAvailableModels({ projectId });
  const { members, canManageMembers } = useProjectMembers({
    isAuthenticated,
    projectId,
  });

  const connectedServerNames = useMemo(
    () =>
      new Set(
        Object.entries(appState.servers)
          .filter(([, server]) => server.connectionStatus === "connected")
          .map(([name]) => name)
      ),
    [appState.servers]
  );

  // Suite visibility already implies suite access; let the backend mutation
  // remain the source of truth for whether deletion is allowed.
  const canDeleteSuite = true;
  const canDeleteRuns = !projectId || canManageMembers;

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
    organizationId,
    connectedServerNames,
    userMap,
    canDeleteSuite,
    canDeleteRuns,
    availableModels,
  };
}
