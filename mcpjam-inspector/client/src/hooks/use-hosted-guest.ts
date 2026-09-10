import { useAuth } from "@workos-inc/authkit-react";
import { HOSTED_MODE } from "@/lib/config";

/**
 * Is the person reading this page a hosted visitor with no account?
 *
 * WORKOS IDENTITY IS THE ONLY HONEST SIGNAL HERE, and the trap this hook
 * exists to close is that Convex's `isAuthenticated` is **true for guests**.
 * A hosted guest gets an anonymous Convex session with a real `users` row and
 * a personal-org project it owns (see `mcpjam-backend/convex/lib/actors.ts`),
 * so it passes `isAuthenticated`, passes `requireProjectRole('member')` on its
 * own project, and looks exactly like a signed-in user to every check except
 * this one. Gate on `isAuthenticated` and every guest walks straight through.
 *
 * Three states, not two:
 *
 *   - `false`  — a real account, or a local install. Local has no WorkOS to
 *                sign up through, so there is nothing to gate and nowhere to
 *                send them; those users keep the product they have today.
 *   - `true`   — hosted, resolved, no account.
 *   - `undefined` — WorkOS has not answered yet. Callers MUST hold rather than
 *                guess: `user` is null during hydrate for signed-in people
 *                too, so treating unresolved as "guest" flashes a sign-up wall
 *                at paying customers on every cold load.
 *
 * Mirrors the `authResolving` guard in `mcp-sidebar.tsx`, which suppresses the
 * signed-out layout for the same window and the same reason.
 */
export function useIsHostedGuest(): boolean | undefined {
  const { user, isLoading } = useAuth();

  if (!HOSTED_MODE) return false;
  // Only unresolved while there is no user to speak of — once WorkOS has
  // handed one over, a lingering `isLoading` (a background refresh) must not
  // re-open the "don't know yet" window on someone already signed in.
  if (!user && isLoading) return undefined;
  return !user;
}
