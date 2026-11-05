/**
 * The once-per-browser seen key. Storage can throw (private mode, blocked
 * site data); the tutorial must never take Evaluate down with it, so a failed
 * read counts as unseen and a failed write is skipped. The app never clears
 * this key, including on flag rollback.
 */

export const HOW_SUITES_WORK_SEEN_KEY = "mcpjam:evals-tutorial-seen";

export function hasSeenHowSuitesWork(): boolean {
  try {
    return localStorage.getItem(HOW_SUITES_WORK_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markHowSuitesWorkSeen(): void {
  try {
    localStorage.setItem(HOW_SUITES_WORK_SEEN_KEY, "1");
  } catch {
    // Blocked storage only means the tutorial may auto-open again later.
  }
}
