import { useCallback, useMemo } from "react";
import { useQuery } from "convex/react";
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

  /**
   * Deleting an eval artifact SOMEONE ELSE created takes the project manage
   * tier — the same `canManageProjectMembers` bar the backend applies to
   * `suite.delete` and `run.delete`. Outside a project (local/playground work)
   * there is no membership to rank, so there is nothing to withhold.
   */
  const canManageEvalArtifacts = !projectId || canManageMembers;
  /**
   * …and the creator of a suite or run may always delete it, whatever their
   * role. That escape hatch is the backend's, not a UI courtesy: it is what
   * lets an interrupted CLI import roll back the suite it just wrote. Gating
   * the affordance on the manage tier ALONE would hide delete from the person
   * who made the thing, on a mutation that would have accepted them.
   *
   * Which is why these are per-row predicates rather than one boolean. A
   * project-wide answer cannot express "yours, not theirs", and the version of
   * this that rounded it off — `canDeleteSuite = true` for everyone — pushed
   * the whole question onto a mutation the user only reaches by clicking
   * delete and watching it fail.
   */
  const convexUser = useQuery("users:getCurrentUser" as any) as
    | { _id?: unknown }
    | null
    | undefined;
  const currentUserId =
    typeof convexUser?._id === "string" ? convexUser._id : null;

  const canDeleteArtifact = useCallback(
    (createdBy?: string | null) =>
      canManageEvalArtifacts ||
      (currentUserId !== null && createdBy === currentUserId),
    [canManageEvalArtifacts, currentUserId]
  );
  /**
   * Whether the run selection + batch-delete surface is worth showing at all.
   * True when the caller could delete SOME run; which runs specifically is
   * `canDeleteArtifact`'s job, and the batch action stays disabled while the
   * selection holds one they cannot.
   */
  const canDeleteRuns = canManageEvalArtifacts || currentUserId !== null;

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
    /** The manage tier on its own — for surfaces that act on no single row. */
    canManageEvalArtifacts,
    /** Per-row: pass the suite's or run's `createdBy`. */
    canDeleteArtifact,
    canDeleteRuns,
    availableModels,
  };
}
