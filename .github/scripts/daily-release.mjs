/**
 * Whether the daily run should remind #prs that a release is ready. It never
 * starts one: a release goes to production, so a person starts it.
 */
export function dailyReleaseDecision({ activeRun, unpublished, releases }) {
  if (activeRun) return { dispatch: false, reason: `Release work is already running: ${activeRun}` };
  if (unpublished.length > 0) {
    return { dispatch: false, reason: "Main still carries unpublished versions. Complete the existing release before preparing another." };
  }
  const pending = releases.filter(({ type }) => type !== "none");
  if (pending.length === 0) return { dispatch: false, reason: "No pending changesets; nothing to release." };
  if (!pending.some(({ name }) => name === "@mcpjam/inspector")) {
    return { dispatch: false, reason: "Pending changesets do not release Inspector. A full production release needs an Inspector changeset." };
  }
  return { dispatch: true, reason: "An Inspector release is ready to start." };
}

/** Runs come from an unfiltered listing: status filters use a search index that can lag minutes behind. */
export function activeRunUrl(runs) {
  return runs.find(({ status }) => status !== "completed")?.html_url ?? null;
}
