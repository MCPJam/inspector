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

/**
 * Session API turns reuse a hosted agent under the Playground's conditions
 * (`warm-approval-binding.ts`). Off by default; read per call.
 */
export function harnessApiWarmEnabled(): boolean {
  return process.env.MCPJAM_HARNESS_API_WARM === "true";
}

/** Hosted native MCP forwarding; read per call so operators can turn it off. */
export function nativeForwardingEnabled(): boolean {
  return process.env.HARNESS_NATIVE_FORWARDING === "true";
}

/** Keep a local Codex runtime between chat turns (`local/kept-runtime.ts`).
 *  Off by default; read per call. */
export function localKeepAgentEnabled(): boolean {
  return process.env.MCPJAM_LOCAL_KEEP_AGENT === "true";
}

/**
 * Keep a warm hosted agent running through its box's pause, up to the box's
 * ceiling. Off by default; read per call so operators can turn it off.
 */
export function harnessKeepAgentThroughPause(): boolean {
  return process.env.MCPJAM_HARNESS_KEEP_THROUGH_PAUSE === "true";
}
