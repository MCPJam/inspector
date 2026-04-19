import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";

/**
 * True when the current session has no WorkOS/Convex identity and no workspace.
 * "Direct guest" covers both hosted (mcpjam.com, no sign-in) and local (npx /
 * electron without sign-in) surfaces. In both cases, eval playground data is
 * treated as guest-owned personal data rather than workspace data.
 *
 * Shared/sandbox guests (have workspaceId + share/sandbox token) are NOT direct
 * guests; they still use Convex-backed flows via the share/sandbox token.
 */
export function useIsDirectGuest({
  workspaceId,
  shareToken,
  sandboxToken,
}: {
  workspaceId?: string | null;
  shareToken?: string | null;
  sandboxToken?: string | null;
} = {}): boolean {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useAuth();

  if (isLoading) return false;
  if (isAuthenticated || user) return false;
  if (workspaceId) return false;
  if (shareToken || sandboxToken) return false;
  return true;
}
