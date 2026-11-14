/**
 * The journey run statuses the backend settles a run into. `running` is the
 * only live status: cancellation and the stale-runner sweep end in one of
 * these rather than adding statuses of their own, so a run reads as finished
 * only once the backend has written one of them.
 */
export const JOURNEY_RUN_TERMINAL_STATUSES = [
  "completed",
  "partial",
  "failed",
  "rate_limited",
] as const;

export type JourneyRunTerminalStatus =
  (typeof JOURNEY_RUN_TERMINAL_STATUSES)[number];

export function isJourneyRunTerminalStatus(
  status: unknown,
): status is JourneyRunTerminalStatus {
  return (JOURNEY_RUN_TERMINAL_STATUSES as readonly unknown[]).includes(status);
}
