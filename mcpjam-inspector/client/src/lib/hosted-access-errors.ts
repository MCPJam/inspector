/**
 * Recognizing a stale hosted-access rejection.
 *
 * Convex `ConvexError` payloads land on `err.data`. The backend throws
 * `{ code: 'scenario_access_stale', currentAccessVersion }` when the client's
 * cached `accessVersion` no longer matches the scenario doc — which happens
 * whenever the share link is rotated or a grant changes mid-session.
 *
 * Recovery is to RE-REDEEM, not to back off and retry locally: the version the
 * client holds will never match again on its own. Every hosted writer needs
 * the same check, which is why it lives here rather than beside the first one
 * that needed it (`useSharedChatWidgetCapture`).
 */
export function isStaleHostedAccessError(error: unknown): boolean {
  return hostedErrorCode(error) === "scenario_access_stale";
}

/**
 * The opposite of a stale-access rejection: nothing recovers this one.
 *
 * A transcript outlives the allowlist. Drop a server from a scenario and the
 * tool calls it already produced stay in the messages the capture hook sweeps,
 * so it re-offers that `serverId` forever. `accessVersion` does not catch it —
 * the client re-redeems, the version matches, and the write is still refused.
 *
 * So this must NOT feed the re-redeem path (there is no fresher version to
 * get) and must not feed the local retry ladder (every attempt lands on the
 * same rejection). Drop the work instead.
 */
export function isServerOutsideScenarioError(error: unknown): boolean {
  return hostedErrorCode(error) === "server_not_in_scenario_allowlist";
}

function hostedErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
