/**
 * One shutdown timeline for both processes that enforce it.
 *
 * The launcher (`bin/start.js`) SIGKILLs a server that outlives it, and the
 * server (`server/index.ts`) force-exits itself. Each kept its own five-second
 * timer, started at a different moment, so the launcher's SIGKILL could land
 * before the server's own deadline and take its timeout log and log flush with
 * it. Both read these numbers now, and the launcher's deadline is derived to
 * land only after everything the server can still do.
 *
 * Plain ESM with no dependencies: the launcher runs under a bare Node before
 * anything is built, and the server bundle inlines it.
 */

/** The server's budget for closing everything before it force-exits. */
export const SHUTDOWN_TEARDOWN_MS = 5_000;

/** How long a force-exit waits for the log flush before exiting anyway. */
export const SHUTDOWN_LOG_FLUSH_MS = 1_000;

/** Slack between the server's own latest exit and the launcher's SIGKILL. */
export const SHUTDOWN_PARENT_MARGIN_MS = 2_000;

export function resolveShutdownSettings() {
  const forceExitMs = SHUTDOWN_TEARDOWN_MS;
  return {
    forceExitMs,
    logFlushMs: SHUTDOWN_LOG_FLUSH_MS,
    parentKillMs:
      forceExitMs + SHUTDOWN_LOG_FLUSH_MS + SHUTDOWN_PARENT_MARGIN_MS,
  };
}
