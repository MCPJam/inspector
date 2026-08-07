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
 *   - Anonymous Convex guests own their personal-org default project, so they
 *     pass once identity has settled. (`useViewerProjectRole` never produces a
 *     role for them — there is no email to match — so gating them on `role`
 *     would lock owners out of their own project.)
 *
 * Fails CLOSED while the role is still resolving, so the button never flashes
 * in and then disappears.
 */
export function usePromoteCapability({
  projectId,
}: {
  projectId: string | null;
}): { canPromote: boolean; isLoading: boolean } {
  const { isAuthenticated } = useConvexAuth();
  const { user, isLoading: identityLoading } = useAuth();
  const { role, isLoading: roleLoading } = useViewerProjectRole({
    isAuthenticated,
    projectId,
    viewerEmail: user?.email,
    identityLoading,
  });

  if (!isAuthenticated || !projectId) {
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
