import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery } from "convex/react";

export type ActorStatus = "loading" | "user" | "guest";

export interface ActorState {
  status: ActorStatus;
  user: unknown | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

/**
 * Resolves the app-level actor from Convex auth plus the materialized users row.
 *
 * Guest Convex tokens can still make `useConvexAuth().isAuthenticated` true, so
 * callers that need a signed-in user should wait for the users query to settle
 * and treat a null row as guest.
 */
export function useActor(): ActorState {
  const { user: workOsUser, isLoading: isWorkOsLoading } = useAuth();
  const { isAuthenticated: hasConvexIdentity, isLoading: isAuthLoading } =
    useConvexAuth();
  const user = useQuery(
    "users:getCurrentUser" as any,
    !isAuthLoading && !isWorkOsLoading && hasConvexIdentity
      ? ({} as any)
      : "skip"
  ) as unknown | null | undefined;

  const isLoading =
    isWorkOsLoading ||
    isAuthLoading ||
    (hasConvexIdentity && user === undefined) ||
    (hasConvexIdentity && !!workOsUser && user === null) ||
    (hasConvexIdentity && !workOsUser && !!user);
  const status: ActorStatus = isLoading
    ? "loading"
    : user && workOsUser
    ? "user"
    : "guest";

  return {
    status,
    user: user ?? null,
    isAuthenticated: status === "user",
    isLoading,
  };
}
