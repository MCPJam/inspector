import { useAuth } from "@workos-inc/authkit-react";

/**
 * Is the person reading this page signed in?
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
 *   - `false`  — a real account.
 *   - `true`   — resolved, no account.
 *   - `undefined` — WorkOS has not answered yet. Callers MUST hold rather than
 *                guess: `user` is null during hydrate for signed-in people
 *                too, so treating unresolved as "guest" flashes a sign-up wall
 *                at paying customers on every cold load.
 *
 * LOCAL INSTALLS ARE NOT EXEMPT, and this is a deliberate reversal. The first
 * version short-circuited to `false` when `HOSTED_MODE` was off, on the
 * reasoning that a local install has no WorkOS to sign up through. That was
 * wrong: local signs in through the same WorkOS and resolves the same identity
 * and plan, so a signed-in local user is a member and a signed-out one is a
 * guest, exactly as on hosted. Exempting local meant a signed-out local user
 * reached the real tab and then failed at the backend instead, which is a
 * worse answer than the preview. (Sophie asked "can we really not gate
 * features on the local app?"; the answer is that we can, and the exemption
 * was the accident.)
 *
 * Mirrors the `authResolving` guard in `mcp-sidebar.tsx`, which suppresses the
 * signed-out layout for the same window and the same reason.
 */
export function useIsHostedGuest(): boolean | undefined {
  const { user, isLoading } = useAuth();

  // Only unresolved while there is no user to speak of. Once WorkOS has handed
  // one over, a lingering `isLoading` (a background refresh) must not re-open
  // the "don't know yet" window on someone already signed in.
  if (!user && isLoading) return undefined;
  return !user;
}
