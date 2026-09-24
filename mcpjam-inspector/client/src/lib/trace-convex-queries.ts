import type { ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { reportCaught } from "./error-reporting";
import { isAuthorizationRefusal } from "./authorization-refusal";
import {
  configureConvexQueryDiagnostics,
  safeQueryError,
} from "./convex-query-diagnostics";

const installed = new WeakSet<ConvexReactClient>();

/** Observe only existing watches and cached results, never issue another query. */
export function traceConvexQueries(
  client: ConvexReactClient,
  url: string,
): void {
  if (installed.has(client)) return;
  configureConvexQueryDiagnostics(url);
  let queryBackend: string | undefined;
  try {
    queryBackend = new URL(url).hostname;
  } catch {
    /* Diagnostics only. */
  }
  const watchQuery = client.watchQuery.bind(client);
  client.watchQuery = (query, ...args) => {
    const watch = watchQuery(query, ...args);
    const report = (error: unknown) => {
      try {
        if (isAuthorizationRefusal(error)) return;
        const original =
          error instanceof Error
            ? error
            : new Error(typeof error === "string" ? error : "Query failed");
        const prefixed = original.message.startsWith("[CONVEX Q(")
          ? original
          : new Error(
              `[CONVEX Q(${getFunctionName(query)})] ${original.message}`,
            );
        reportCaught(safeQueryError(prefixed), {
          source: "convex_query_subscription",
          queryBackend,
        });
      } catch {
        // Observability must not change subscription behavior.
      }
    };
    const inspect = () => {
      try {
        watch.localQueryResult();
      } catch (error) {
        report(error);
      }
    };
    return {
      ...watch,
      localQueryResult: () => {
        try {
          return watch.localQueryResult();
        } catch (error) {
          report(error);
          throw error;
        }
      },
      onUpdate: (callback) => {
        const unsubscribe = watch.onUpdate(() => {
          inspect();
          callback();
        });
        inspect(); // A newly attached watch can already have a cached failure.
        return unsubscribe;
      },
    };
  };
  installed.add(client);
}
