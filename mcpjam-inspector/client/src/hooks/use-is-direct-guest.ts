import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { HOSTED_MODE } from "@/lib/config";

/**
 * True when the current session has no WorkOS/Convex identity and no project.
 * Hosted guests are Convex-backed and should not use this local-only escape
 * hatch.
 *
 * Shared/sandbox guests (have projectId + share/sandbox token) are NOT direct
 * guests; they still use Convex-backed flows via the share/sandbox token.
 */
export function useIsDirectGuest({
  projectId,
  shareToken,
  sandboxToken,
}: {
  projectId?: string | null;
  shareToken?: string | null;
  sandboxToken?: string | null;
} = {}): boolean {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useAuth();

  if (HOSTED_MODE) return false;
  if (isLoading) return false;
  if (isAuthenticated || user) return false;
  if (projectId) return false;
  if (shareToken || sandboxToken) return false;
  return true;
}
