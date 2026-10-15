/**
 * Harness feature flags shared by the pre-stream availability check and the
 * turn executor. Lives in its own module so `harness-availability.ts` can read
 * the broker flag without importing `run-harness-turn.ts` (import cycle).
 */

/**
 * Inspector-side gate for E2B header-broker credential delivery.
 *
 * KILL SWITCH, default ON (COMP-23): the broker is the ONLY credential path —
 * the raw-key client path (`fetchHarnessModelCredential` → backend
 * `/web/harness/model-credential`) was removed because it spent the system AI
 * Gateway key with zero metering. Setting `MCPJAM_HARNESS_BROKER_DELIVERY=false`
 * makes harness runs UNAVAILABLE with an honest pre-stream error; it never
 * falls back to a raw key (there is none to fall back to).
 */
export function harnessBrokerDeliveryEnabled(): boolean {
  return process.env.MCPJAM_HARNESS_BROKER_DELIVERY !== "false";
}
