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
 * Per-request budget for a hosted MCP call, and the default an eval SUITE run
 * connects with when its client pins nothing of its own.
 *
 * NOT universal across eval paths, and the settings card is scoped to suite
 * runs for that reason: `/api/web/evals/stream-test-case` declares its own
 * 60s budget for a single streamed case, because one case can hold a
 * connection across several model turns.
 */
export const WEB_CALL_TIMEOUT_MS = 30_000;

/** Streaming turns, which hold a connection open across many model calls. */
export const WEB_STREAM_TIMEOUT_MS = 120_000;

/**
 * Connect + list tools before a hosted chat turn streams. Nothing reaches the
 * browser until this finishes, and Cloudflare drops a request that has sent no
 * first byte after 100 s (a 524) — so a hung MCP server has to fail the turn
 * with our own 424 well inside that, not after the per-request timeout above
 * and its retries.
 */
export const WEB_CHAT_TOOL_LISTING_TIMEOUT_MS = 30_000;

/**
 * Hosted Connect (`/api/web/servers/validate`), counted from when the request
 * reaches the server — the server-check queue wait included. The Connect
 * button gives up 50 s after it sends the request (`validateHostedServer`),
 * so the server has to answer inside that, with a few seconds left for the
 * trip back. Without it the per-request timeout and its retries let a hung
 * MCP server hold the check for minutes after the user was told it timed out.
 */
export const WEB_SERVER_CHECK_DEADLINE_MS = 45_000;
