import { ConvexError } from "convex/values";

/** Retry only explicit OCC rollbacks: an ambiguous network failure may have committed. */
export async function retrySuiteStartOnConflict<T>(
  start: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await start();
    } catch (error) {
      // Structured refusals (including billing limits) are never retried.
      const message = error instanceof Error ? error.message : "";
      const conflict =
        !(error instanceof ConvexError) &&
        (message.includes("changed while this mutation was being run") ||
          message.includes("OptimisticConcurrencyControlFailure"));
      if (!conflict || attempt >= 3) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.random() * 250 * 2 ** attempt),
      );
    }
  }
}
