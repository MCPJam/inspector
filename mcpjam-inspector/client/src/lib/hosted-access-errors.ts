/**
 * Recognizing a stale hosted-access rejection.
 *
 * Convex `ConvexError` payloads land on `err.data`. The backend throws
 * `{ code: 'scenario_access_stale', currentAccessVersion }` when the client's
 * cached `accessVersion` no longer matches the scenario doc — which happens
 * whenever the share link is rotated or a grant changes mid-session. The
 * upload route (`@/shared/blob-upload`) answers the same case with a 403 whose
 * `reason` is `scenario_access_stale`, carried on `err.data.reason`.
 *
 * Recovery is to RE-REDEEM, not to back off and retry locally: the version the
 * client holds will never match again on its own. Every hosted writer needs
 * the same check, which is why it lives here rather than beside the first one
 * that needed it (`useSharedChatWidgetCapture`).
 */
export function isStaleHostedAccessError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object") return false;
  const { code, reason } = data as { code?: unknown; reason?: unknown };
  return (
    code === "scenario_access_stale" ||
    code === "SCENARIO_SIGN_IN_REQUIRED" ||
    reason === "scenario_access_stale"
  );
}
