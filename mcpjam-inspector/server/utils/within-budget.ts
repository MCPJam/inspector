/**
 * Races a connect + tool listing against `timeoutMs`; with no budget it is the
 * listing.
 *
 * The listing that loses is abandoned, not cancelled — the caller's manager
 * cleanup (`disconnectAllServers`) is what stops the stuck connect. Its
 * eventual rejection is swallowed here so it cannot surface as unhandled.
 *
 * The expiry error names the server (`MCP server "<name>" timed out`), so
 * `mapTargetServerError` serves it as a 424 `TIMEOUT`, and is a
 * `TimeoutError`, so the hosted projection words it as a request that got no
 * answer in time rather than by the last HTTP exchange it happened to log.
 */
export async function withinToolListingBudget<T>(
  listing: Promise<T>,
  timeoutMs: number | undefined,
  describeServers: () => string,
): Promise<T> {
  if (timeoutMs === undefined) return listing;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      listing,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          listing.catch(() => {});
          const error = new Error(
            `MCP server ${describeServers()} timed out: connecting and listing tools took longer than ${Math.round(timeoutMs / 1000)}s.`,
          );
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    // Leaving the timer live would hold the event loop open for the rest of
    // the budget on every healthy turn.
    if (timer !== undefined) clearTimeout(timer);
  }
}
