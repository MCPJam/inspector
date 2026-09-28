import type { ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { reportCaught } from "./error-reporting";
import { isAuthorizationRefusal } from "./authorization-refusal";
import {
  configureConvexQueryDiagnostics,
  safeQueryError,
} from "./convex-query-diagnostics";

const installed = new WeakSet<ConvexReactClient>();

/**
 * The backend's structured "this run or suite was deleted" answer. A page
 * still watching a run the user just deleted gets this once before the list
 * drops it; the page already treats it as a failed run, so it is not a fault.
 */
function isParentDeletedRefusal(error: unknown): boolean {
  return (
    error instanceof ConvexError &&
    (error.data as { reason?: unknown } | undefined)?.reason ===
      "eval_parent_deleted"
  );
}

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
    let lastReportedMessage: string | undefined;
    const report = (error: unknown) => {
      try {
        if (isAuthorizationRefusal(error) || isParentDeletedRefusal(error))
          return;
        const original =
          error instanceof Error
            ? error
            : new Error(typeof error === "string" ? error : "Query failed");
        const prefixed = original.message.startsWith("[CONVEX Q(")
          ? original
          : new Error(
              `[CONVEX Q(${getFunctionName(query)})] ${original.message}`,
            );
        const safe = safeQueryError(prefixed);
        if (safe.message === lastReportedMessage) return;
        reportCaught(safe, {
          source: "convex_query_subscription",
          queryBackend,
        });
        lastReportedMessage = safe.message;
      } catch {
        // Observability must not change subscription behavior.
      }
    };
    const inspect = () => {
      try {
        watch.localQueryResult();
        lastReportedMessage = undefined;
      } catch (error) {
        report(error);
      }
    };
    return {
      ...watch,
      localQueryResult: () => {
        try {
          const result = watch.localQueryResult();
          lastReportedMessage = undefined;
          return result;
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
