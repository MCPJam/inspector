import { useConvexAuth } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";

/**
 * Whether this actor may issue a Convex read right now.
 *
 * Only an actor that HAS a Convex identity has a `users` row coming, so only
 * that actor waits: reads issued between auth landing and `users:ensureUser`
 * resolving hit functions that expect the row. This covers signed-in users and
 * hosted guests alike — a hosted guest holds a guest token, so Convex reports
 * it authenticated.
 *
 * An actor with no Convex identity (a direct, local-mode guest) never gets a
 * row and so must never wait on one; gating it on readiness would skip its
 * queries forever. It reads exactly as it did before the gate existed.
 */
export function useActorCanQuery(): boolean {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const isUserReady = useDbUserReady();
  // While Convex is still resolving auth, `isAuthenticated` reads false for an
  // actor that is about to be authenticated. Treating that as "no identity,
  // read away" would fire the query unauthenticated in exactly the window this
  // gate exists to cover, so wait for auth to settle first.
  if (isLoading) return false;
  return !isAuthenticated || isUserReady;
}
