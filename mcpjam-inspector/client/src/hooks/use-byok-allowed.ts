import { useAuth } from "@workos-inc/authkit-react";

/**
 * Gate for "bring your own key" features. Returns true when the current
 * session has a signed-in WorkOS identity. Anonymous sessions (direct
 * guests, hosted guest JWTs) are blocked from saving or reading provider
 * keys.
 *
 * Optimistic during auth loading: returns true so saved keys don't flash
 * out for signed-in users on first paint. Resolves to the real value once
 * isLoading is false.
 */
export function useByokAllowed(): boolean {
  const { user, isLoading } = useAuth();
  if (isLoading) return true;
  return !!user;
}
