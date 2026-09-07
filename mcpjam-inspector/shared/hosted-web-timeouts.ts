/**
 * Timeouts every hosted web route applies, in milliseconds.
 *
 * SERVER-SIDE SOURCE OF TRUTH. `server/config.ts` re-exports these, and the 13
 * route/service modules that import them keep importing from there — this file
 * exists so the CLIENT can read the same numbers.
 *
 * The client reads them only to DESCRIBE what a hosted run will do (the
 * Connection stage card on the eval suite settings page says "30 s · fixed for
 * eval runs"). Nothing client-side enforces them: the request timeout a hosted
 * eval run actually applies is set once, uniformly, where the manager is built
 * (`createAuthorizedManager`). A copy of the number in the UI would drift the
 * moment somebody tuned the route, and the drift would be invisible — the card
 * would keep stating a value no run had used since.
 */

/** Connect/authorize round trips. */
export const WEB_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Per-request budget for a hosted MCP call, and the uniform timeout every
 * hosted EVAL run connects with. Server-row `timeout`, host
 * `connectionDefaults.requestTimeout` and per-server `requestTimeoutOverride`
 * are not applied on the eval path (only the swarm runner threads per-server
 * timeouts), which is why the settings card names this value and says so.
 */
export const WEB_CALL_TIMEOUT_MS = 30_000;

/** Streaming turns, which hold a connection open across many model calls. */
export const WEB_STREAM_TIMEOUT_MS = 120_000;
