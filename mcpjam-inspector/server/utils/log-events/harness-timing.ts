/**
 * The `harness.timing` log event, the `[harness][timing]` line one harness
 * turn writes when its model stream ends: its bootstrap observation, and the
 * route's `TurnTiming` fields. Closed values and whole milliseconds only.
 * The telemetry catalog reads payloads in this folder as it reads
 * `log-events.ts`, so these fields reach the log row.
 */
export type HarnessTimingEvent = {
  harnessId?: "claude-code" | "codex" | "copilot-cli" | "cursor" | "opencode";
  harnessBootstrap?: "baked" | "installed" | "install-failed" | "reused" | "none";
  harnessBakeExpected?: "baked" | "custom-workdir" | "unbaked-recipe" | "none";
  harnessBakeOnBox?: "present" | "absent" | "unknown" | "not-checked";
  harnessTurn?: "failed";
  /**
   * `TurnTiming` (`turn-timing.ts`), in whole milliseconds: each route stage
   * before the model stream, and the request's time to its first text.
   */
  setupMs?: number;
  turnAuthorizationMs?: number;
  connectionsMs?: number;
  toolsMs?: number;
  streamPreparationMs?: number;
  firstTextMs?: number;
  /**
   * The route creating or waking the turn's box before the turn began;
   * `boxWake` plus this is the turn event's `box_wake_ms`.
   */
  boxAcquisitionMs?: number;
};
