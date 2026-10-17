/**
 * Types for the shared shutdown timeline. `bin/` is plain ESM that runs under a
 * bare Node before anything is built, so this is a hand-written declaration;
 * the server imports the module and its bundle inlines it.
 */
export declare const SHUTDOWN_TEARDOWN_MS: number;
export declare const SHUTDOWN_LOG_FLUSH_MS: number;
export declare const SHUTDOWN_PARENT_MARGIN_MS: number;

export declare function resolveShutdownSettings(): {
  /** When the server force-exits itself after a shutdown signal. */
  forceExitMs: number;
  /** How long that force-exit waits for the log flush. */
  logFlushMs: number;
  /** When the launcher SIGKILLs a server still running after SIGTERM. */
  parentKillMs: number;
};
