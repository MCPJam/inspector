import { useMutation, useQuery } from "convex/react";
import { useConvexAuth } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { shouldQueryProjectId } from "@/hooks/useProjects";

/**
 * Project-scoped synthetic XAA test identities ("People" in the XAA debugger).
 * Hand-mirrored from the backend `testIdentities` serializer — the wire type
 * is maintained by hand like `RemoteServer` (two-repo layout).
 */
export interface RemoteXaaPerson {
  _id: string;
  name: string;
  subject: string;
  email: string;
  color?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Roster query. Self-contained auth gating (unlike `useProjectServers`, which
 * takes `isAuthenticated` as a prop): guests are authenticated Convex actors
 * too, so the roster works for guest sessions; only signed-out/local-only
 * states skip the query and the debugger falls back to its default identity.
 */
export function useXaaPeople({ projectId }: { projectId: string | null }) {
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const shouldQuery =
    isAuthenticated && isUserReady && shouldQueryProjectId(projectId);
  const queryProjectId = projectId?.trim() ?? "";

  const people = useQuery(
    "testIdentities:listTestIdentities" as any,
    shouldQuery ? ({ projectId: queryProjectId } as any) : "skip",
  ) as RemoteXaaPerson[] | undefined;

  return {
    people,
    isLoading: shouldQuery && people === undefined,
    /** False when the query is skipped entirely (signed out / no project). */
    isAvailable: shouldQuery,
  };
}

export function useXaaPeopleMutations() {
  const create = useMutation("testIdentities:createTestIdentity" as any);
  const update = useMutation("testIdentities:updateTestIdentity" as any);
  const remove = useMutation("testIdentities:deleteTestIdentity" as any);
  return { create, update, remove };
}
