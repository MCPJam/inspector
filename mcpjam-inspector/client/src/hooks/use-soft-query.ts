import { useQueries } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { useMemo } from "react";

export interface SoftQueryResult<T> {
  /** Undefined while loading AND after an error; read `error` to tell which. */
  data: T | undefined;
  error: Error | undefined;
}

/**
 * `useQuery` for reads the app keeps working without.
 *
 * Convex's `useQuery` rethrows a query's server error during render. Hooks the
 * app shell calls render above the router's only error element, so on
 * 2026-10-04 one billing read that hit Convex's 16 MiB read limit replaced every
 * page with "Something went wrong" for that organization. `useQueries` hands
 * the error back instead of throwing it; this gives it `useQuery`'s calling
 * convention.
 *
 * The failure is still reported: `traceConvexQueries` observes every
 * subscription, this one included.
 *
 * Use it only where the screen is still correct without the answer: billing
 * badges, credit and quota meters, notifications. The signed-in user, their
 * organizations and the data a page is about should keep throwing.
 */
export function useSoftQuery<T>(
  name: string,
  // `undefined` values are dropped, as Convex drops them.
  args: Record<string, Value | undefined> | "skip",
): SoftQueryResult<T> {
  const argsKey = args === "skip" ? null : JSON.stringify(args);
  // Convex keys its subscription by this object's identity, so it may only
  // change when the query or its arguments do.
  const queries = useMemo<Parameters<typeof useQueries>[0]>(
    (): Parameters<typeof useQueries>[0] =>
      argsKey === null
        ? {}
        : {
            result: {
              query: makeFunctionReference<"query">(name),
              args: JSON.parse(argsKey) as Record<string, Value>,
            },
          },
    [name, argsKey],
  );
  const result = useQueries(queries).result as T | Error | undefined;
  return result instanceof Error
    ? { data: undefined, error: result }
    : { data: result, error: undefined };
}
