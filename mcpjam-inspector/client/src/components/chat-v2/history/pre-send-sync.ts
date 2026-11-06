/**
 * How long a send waits for the pre-send history sync. The composer holds its
 * send lock across that request, so one that never settles would leave Send
 * spinning; this matches the 15 s server-readiness limit.
 */
export const PRE_SEND_SYNC_TIMEOUT_MS = 15_000;
