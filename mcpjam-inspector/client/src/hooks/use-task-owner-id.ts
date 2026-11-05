import { useConvexAuth, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useActorCanQuery } from "./use-actor-can-query";

const currentUser = makeFunctionReference<
  "query",
  Record<string, never>,
  { _id: string } | null
>("users:getCurrentUser");

/** Use the identity Convex holds, including guest/bootstrap transitions. */
export function useTaskOwnerId(): string | undefined {
  const { isAuthenticated } = useConvexAuth();
  const canQuery = useActorCanQuery();
  const user = useQuery(currentUser, isAuthenticated && canQuery ? {} : "skip");
  return user?._id;
}
