/**
 * Whether this browser has already been shown the "How suites work" tutorial.
 * Per browser on purpose: the tutorial opens on its own once, then only from
 * the Evaluate ⋮ menu.
 */
export const HOW_SUITES_WORK_SEEN_KEY = "mcpjam:evals-tutorial-seen:v1";

export function hasSeenHowSuitesWork(): boolean {
  try {
    return localStorage.getItem(HOW_SUITES_WORK_SEEN_KEY) === "1";
  } catch {
    // Storage is blocked, so a write would not stick either. Count it as seen
    // rather than opening the dialog on every visit; the menu still opens it.
    return true;
  }
}

export function markHowSuitesWorkSeen(): void {
  try {
    localStorage.setItem(HOW_SUITES_WORK_SEEN_KEY, "1");
  } catch {
    // Storage is blocked. Safe to ignore: reads fail the same way and report
    // the tutorial as seen, so it cannot reopen on its own.
  }
}
