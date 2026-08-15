/**
 * Recognizing a stale hosted-access rejection.
 *
 * Convex `ConvexError` payloads land on `err.data`. The backend throws
 * `{ code: 'chatbox_access_stale', currentAccessVersion }` when the client's
 * cached `accessVersion` no longer matches the chatbox doc — which happens
 * whenever the share link is rotated or a grant changes mid-session.
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
  return (data as { code?: unknown }).code === "chatbox_access_stale";
}
