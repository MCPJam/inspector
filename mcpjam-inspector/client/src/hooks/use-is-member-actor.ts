import { useConvexAuth, useQuery } from "convex/react";
import { useActorCanQuery } from "./use-actor-can-query";

/**
 * Is the identity CONVEX CURRENTLY HOLDS a signed-in member?
 *
 * Read this — never WorkOS `useAuth().user` — before firing a member-only
 * Convex function. The two disagree, routinely, and the window is not a rare
 * race:
 *
 * In hosted production every SPA document is served with
 * `window.__MCP_GUEST_BOOTSTRAP__` injected (`server/app.ts`), with no check for
 * a session cookie — a signed-in user gets a guest bearer in their HTML too.
 * `guest-session.ts` seeds it at module eval, so `useUnifiedConvexAuth` hands
 * the adapter a guest token before the first render; the adapter sets
 * `isAuthenticated: !!user` and Convex confirms auth as `guest|<uuid>`. AuthKit
 * resolves the real user only afterwards, and the token swap happens in an
 * effect one commit later. For that commit, WorkOS says "member", Convex says
 * "authenticated", and the socket is carrying a GUEST.
 *
 * A gate built from `isAuthenticated && workosUser && isUserReady` asserts four
 * things that are each true and none of which is "the JWT in the socket belongs
 * to this user". `users:getCurrentUser` is that missing fact: it is a
 * `publicQuery` (safe for guests and for no identity at all) whose answer is
 * resolved by the backend from the JWT it actually received, so `isAnonymous`
 * reports the identity that a member-only function would see.
 *
 * Tri-state on purpose, and callers must treat `undefined` as "do not ask yet":
 * collapsing it to `false` bounces a legitimate member who cold-loads a URL,
 * and collapsing it to `true` re-opens the window this hook exists to close.
 */
export function useIsMemberActor(): boolean | undefined {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const canQuery = useActorCanQuery();

  const currentUser = useQuery(
    "users:getCurrentUser" as any,
    isAuthenticated && canQuery ? ({} as any) : "skip",
  ) as { isAnonymous?: boolean } | null | undefined;

  // Still settling. `isAuthenticated` reads false for an actor about to be
  // authenticated, so this is not yet "no identity".
  if (isLoading) return undefined;
  // No Convex identity at all (a direct, local-mode guest). Never a member, and
  // never waiting on a row that is not coming.
  if (!isAuthenticated) return false;
  if (!canQuery || currentUser === undefined) return undefined;
  // `null` is a real answer from a `publicQuery`: identity present, no row this
  // caller may see. Not a member.
  if (currentUser === null) return false;
  return currentUser.isAnonymous !== true;
}
