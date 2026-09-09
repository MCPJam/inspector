/**
 * Exact "Suite 1", "Suite 2", … names. Anything else (including
 * "Suite 1 extra" or a server-card prefill) is ignored when incrementing.
 */
const NUMBERED_SUITE_NAME = /^Suite (\d+)$/;

/**
 * Fallback when no numbered suites exist yet. Also the empty-after-clear
 * placeholder when the caller does not pass existing names.
 */
export const DEFAULT_CREATE_SUITE_NAME = "Suite 1";

/**
 * Next unused "Suite N" from existing names. Takes one past the highest
 * exact match; names that do not match `/^Suite (\d+)$/` are ignored.
 */
export function nextUnusedSuiteName(
  existingNames: ReadonlyArray<string> = [],
): string {
  let highest = 0;
  for (const name of existingNames) {
    const match = NUMBERED_SUITE_NAME.exec(name);
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > highest) {
      highest = n;
    }
  }
  return `Suite ${highest + 1}`;
}

/**
 * Empty-hero server cards and URL/agent prefills win; otherwise the
 * page starts with the next unused "Suite N" so Continue is enabled
 * on first paint.
 */
export function seedCreateSuiteName(
  initialName?: string | null,
  existingNames: ReadonlyArray<string> = [],
): string {
  return initialName?.trim()
    ? initialName
    : nextUnusedSuiteName(existingNames);
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
