/**
 * A check that was skipped because an earlier check broke says which one.
 *
 * The skip is still `could-not-run` (yellow, costs a point): the server is the
 * reason the check never ran. Naming the check that broke first tells the
 * reader where to look instead of leaving them with "the session is no longer
 * healthy".
 *
 * Pure data, safe for the browser entry.
 */

/** `details` key holding the id of the check that blocked this one. */
export const BLOCKED_BY_DETAIL = "blockedBy";

/** The skip message for a check blocked by `blockerTitle`. */
export function blockedByMessage(blockerTitle: string): string {
  return `Skipped because "${blockerTitle}" failed first.`;
}

/** The skip message when the server stopped answering after timeouts. */
export function stoppedAnsweringMessage(timedOutTitles: string[]): string {
  if (timedOutTitles.length === 0) {
    return "Skipped because the server stopped responding.";
  }
  const quoted = timedOutTitles.map((title) => `"${title}"`);
  const list =
    quoted.length === 1
      ? quoted[0]
      : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
  return `Skipped because the server stopped responding (${list} timed out).`;
}

/** `details` naming the blocking check. */
export function blockedByDetails(blockerId: string): Record<string, unknown> {
  return { [BLOCKED_BY_DETAIL]: blockerId };
}
