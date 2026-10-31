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
 * The drain comes first: after a shutdown signal the server stops admitting
 * and claiming new work and gives in-flight work up to `drainMs` to finish,
 * then tears down within its usual budget. It is off unless a deployment asks
 * for it (`MCPJAM_SHUTDOWN_DRAIN_MS`), so a local Ctrl-C stays fast, and it is
 * clamped to the platform's own SIGTERM-to-SIGKILL window when the process can
 * see it (`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`): a drain the platform cuts
 * short would end in a SIGKILL instead of the teardown it exists to reach.
 *
 * Plain ESM with no dependencies: the launcher runs under a bare Node before
 * anything is built, and the server bundle inlines it.
 */

/** The server's budget for closing everything once the drain is over. */
export const SHUTDOWN_TEARDOWN_MS = 5_000;

/** How long a force-exit waits for the log flush before exiting anyway. */
export const SHUTDOWN_LOG_FLUSH_MS = 1_000;

/** Slack between the server's own latest exit and the launcher's SIGKILL. */
export const SHUTDOWN_PARENT_MARGIN_MS = 2_000;

/** Whole milliseconds, or undefined when unset, blank or not a count. */
function readMs(raw, scale = 1) {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw) * scale;
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

export function resolveShutdownSettings(env = process.env) {
  const requestedDrainMs = readMs(env.MCPJAM_SHUTDOWN_DRAIN_MS) ?? 0;
  const platformWindowMs = readMs(env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS, 1000);
  // Everything the server still does after the drain, plus the launcher's
  // margin, has to fit inside the platform's window too.
  const platformDrainMs =
    platformWindowMs === undefined
      ? undefined
      : Math.max(
          0,
          platformWindowMs -
            SHUTDOWN_TEARDOWN_MS -
            SHUTDOWN_LOG_FLUSH_MS -
            SHUTDOWN_PARENT_MARGIN_MS,
        );
  const drainMs =
    platformDrainMs === undefined
      ? requestedDrainMs
      : Math.min(requestedDrainMs, platformDrainMs);
  const forceExitMs = drainMs + SHUTDOWN_TEARDOWN_MS;
  return {
    drainMs,
    /** True when the platform window cut the requested drain short. */
    drainClamped: drainMs < requestedDrainMs,
    forceExitMs,
    logFlushMs: SHUTDOWN_LOG_FLUSH_MS,
    parentKillMs:
      forceExitMs + SHUTDOWN_LOG_FLUSH_MS + SHUTDOWN_PARENT_MARGIN_MS,
  };
}
