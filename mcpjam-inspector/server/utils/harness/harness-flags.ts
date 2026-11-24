/**
 * Operator switches for harness features not yet verified live, each off by
 * default and read per call.
 */

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
