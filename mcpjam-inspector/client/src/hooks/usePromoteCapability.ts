import { useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { canPromoteSessions, useViewerProjectRole } from "@/hooks/useProjects";

/**
 * May this viewer promote a session into an eval test case?
 *
 * Promotion is member-gated server-side (`PROMOTION_POLICIES`), so this only
 * decides whether to render the affordance — the backend refuses regardless.
 * The point is that a project guest, who legitimately reads User Testing
 * sessions, never sees a button that throws when clicked.
 *
 * Two identity paths, mirroring the Swarms route gate:
 *   - WorkOS-signed-in viewers resolve a project role from the members list.
 *   - Anonymous Convex sessions own their personal-org default project, so
 *     they pass once identity has settled. (`useViewerProjectRole` never
 *     produces a role for them — there is no email to match — so gating them
 *     on `role` would lock owners out of their own project.)
 *
 * KNOWN LOOSENESS in that second path, matching the precedent in
 * `SwarmsRoute`: `isAuthenticated` is also true for HOSTED anonymous guests,
 * and this branch cannot tell a personal-org owner from one. A hosted guest
 * who reached someone else's project would see the affordance and get a
 * descriptive backend refusal on click. Accepted because the backend is the
 * real gate and anonymous actors normally only reach their own project;
 * tightening it needs an owner check the members list can't answer for an
 * email-less viewer.
 *
 * Fails CLOSED while ANY identity signal is still resolving — Convex auth,
 * WorkOS hydrate, or the members list — so the button never flashes in and
 * then disappears (or, worse, appears only after the user has looked away).
 */
export function usePromoteCapability({
  projectId,
}: {
  projectId: string | null;
}): { canPromote: boolean; isLoading: boolean } {
  const { isAuthenticated, isLoading: convexAuthLoading } = useConvexAuth();
  const { user, isLoading: identityLoading } = useAuth();
  const { role, isLoading: roleLoading } = useViewerProjectRole({
    isAuthenticated,
    projectId,
    viewerEmail: user?.email,
    identityLoading,
  });

  if (!projectId) {
    return { canPromote: false, isLoading: false };
  }

  // Convex reports `isAuthenticated: false` while it is still confirming the
  // initial token, so an unauthenticated answer is only trustworthy once its
  // own loading flag has cleared.
  if (convexAuthLoading) {
    return { canPromote: false, isLoading: true };
  }
  if (!isAuthenticated) {
    return { canPromote: false, isLoading: false };
  }

  // Anonymous Convex session: no WorkOS user to resolve a role against.
  if (!identityLoading && !user?.email) {
    return { canPromote: true, isLoading: false };
  }

  if (identityLoading || roleLoading) {
    return { canPromote: false, isLoading: true };
  }

  return { canPromote: canPromoteSessions(role), isLoading: false };
}
