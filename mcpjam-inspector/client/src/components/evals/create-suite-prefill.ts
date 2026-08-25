/**
 * Seeded into the name field when there is no empty-hero / URL / agent
 * prefill, so Continue is enabled on first paint. Also used as the
 * empty-after-clear placeholder.
 */
export const DEFAULT_CREATE_SUITE_NAME = "Customer support workflows";

/**
 * Empty-hero server cards and URL/agent prefills win; otherwise the
 * page starts with a real default so the user can Continue immediately.
 */
export function seedCreateSuiteName(initialName?: string | null): string {
  return initialName?.trim() ? initialName : DEFAULT_CREATE_SUITE_NAME;
}

/**
 * Prefer an exact single-server group for `serverId`; otherwise the
 * smallest group that includes it. Returns null when nothing matches so
 * callers do not silently attach a different server's group.
 */
export function pickServerAttachmentIdForServer(
  attachments: ReadonlyArray<{ _id: string; serverIds: string[] }>,
  serverId: string,
): string | null {
  const containing = attachments.filter((attachment) =>
    attachment.serverIds.includes(serverId),
  );
  if (containing.length === 0) {
    return null;
  }
  const exact = containing.find(
    (attachment) =>
      attachment.serverIds.length === 1 && attachment.serverIds[0] === serverId,
  );
  if (exact) {
    return exact._id;
  }
  return [...containing].sort(
    (left, right) => left.serverIds.length - right.serverIds.length,
  )[0]._id;
}
