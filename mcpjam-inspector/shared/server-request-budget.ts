/**
 * The marker on a refusal from the per-server request budget on the hosted MCP
 * operation routes (MJ-012, `server/middleware/mcp-operation-rate-limit.ts`).
 *
 * Shared because the two ends of this fact are in different runtimes: the
 * middleware puts it on the `details` of its 429, and the client's `webPost`
 * retries only the refusals that carry it. Every other 429 stays an error, so a
 * private copy of this string on either side would quietly turn the retry off
 * the first time one of them was edited. Kebab-case, like the other `reason`
 * fields on web error envelopes.
 */
export const SERVER_REQUEST_BUDGET_REASON = "server-request-budget";

/** The `details` that refusal carries on its web error envelope. */
export interface ServerRequestBudgetDetails {
  reason: typeof SERVER_REQUEST_BUDGET_REASON;
}

/** True when a web error envelope's `details` marks that refusal. */
export function isServerRequestBudgetRefusal(details: unknown): boolean {
  return (
    typeof details === "object" &&
    details !== null &&
    (details as { reason?: unknown }).reason === SERVER_REQUEST_BUDGET_REASON
  );
}
