import { getFunctionName } from "convex/server";

type QueryRequests = Record<string, { query: any; args: unknown }>;

/**
 * A `useQueries` for a `convex/react` mock, answered by that mock's own
 * `useQuery(name, args)`.
 *
 * Soft reads (`useSoftQuery`: billing, credits, quota, notifications) subscribe
 * through `useQueries`, so a mock that stubs only `useQuery` has no export for
 * them and the hook under test throws. This keeps one source of answers per
 * test file. A skipped soft read sends no request at all, so it never reaches
 * `useQuery` with "skip".
 *
 * Call it lazily from the factory — `useQueries: (q) => useQueriesVia(fn)(q)`
 * — because `vi.mock` factories are hoisted above this import.
 */
export function useQueriesVia(
  useQuery: (name: string, args: unknown) => unknown,
) {
  return (queries: QueryRequests) =>
    Object.fromEntries(
      Object.entries(queries).map(([key, { query, args }]) => [
        key,
        useQuery(getFunctionName(query), args),
      ]),
    );
}

/**
 * Adds that `useQueries` to a whole `convex/react` mock object, answered by the
 * object's own `useQuery`. Import it inside an async factory:
 *
 *   vi.mock("convex/react", async () =>
 *     (await import("@/test/mocks/convex-use-queries")).withUseQueries({ … }));
 */
export function withUseQueries<
  T extends { useQuery?: (name: any, args: any) => unknown },
>(mocked: T): T & { useQueries: (queries: QueryRequests) => unknown } {
  return {
    ...mocked,
    useQueries: (queries: QueryRequests) =>
      useQueriesVia((name, args) => mocked.useQuery?.(name, args))(queries),
  };
}
