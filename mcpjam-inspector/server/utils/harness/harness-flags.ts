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

/** A comma-separated organization list; empty or unset allows every one. */
function listsOrganization(list: string | undefined, organizationId: string): boolean {
  const organizations = (list ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return organizations.length === 0 || organizations.includes(organizationId);
}

/** Hosted reuse defaults on; operators can disable it or restrict organizations. */
export function hostedWarmAgentEnabled(organizationId: string | undefined): boolean {
  const enabled = process.env.MCPJAM_HOSTED_WARM_AGENT?.trim().toLowerCase();
  if (!organizationId || enabled === "0" || enabled === "false") return false;
  return listsOrganization(process.env.MCPJAM_HOSTED_WARM_AGENT_ORG_IDS, organizationId);
}

/** Whether box preparation is on at all; off unless operators turn it on. */
export function harnessPrepareBoxSwitchedOn(): boolean {
  const enabled = process.env.MCPJAM_HARNESS_PREPARE_BOX?.trim().toLowerCase();
  return enabled === "1" || enabled === "true";
}

/**
 * Preparing a new hosted chat's computer while its first message is typed,
 * for this organization. Operators can restrict organizations; the backend's
 * per-organization flag still decides for each one.
 */
export function harnessPrepareBoxEnabled(organizationId: string | undefined): boolean {
  if (!organizationId || !harnessPrepareBoxSwitchedOn()) return false;
  return listsOrganization(process.env.MCPJAM_HARNESS_PREPARE_BOX_ORG_IDS, organizationId);
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
