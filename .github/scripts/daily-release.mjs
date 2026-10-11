/** Keep the daily run from replacing a reviewed PR or overlapping a release. */
export function dailyReleaseDecision({ activeRun, versionPr, unpublished, releases }) {
  if (activeRun) return { dispatch: false, reason: `Release work is already running: ${activeRun}` };
  if (versionPr) return { dispatch: false, reason: `Review and merge the existing version PR: ${versionPr}` };
  if (unpublished.length > 0) {
    return { dispatch: false, reason: "Main still carries unpublished versions. Complete the existing release before preparing another." };
  }
  const pending = releases.filter(({ type }) => type !== "none");
  if (pending.length === 0) return { dispatch: false, reason: "No pending changesets; nothing to release." };
  if (!pending.some(({ name }) => name === "@mcpjam/inspector")) {
    return { dispatch: false, reason: "Pending changesets do not release Inspector. A full production release needs an Inspector changeset." };
  }
  return { dispatch: true, reason: "Prepare an Inspector release with backend and webapp production deploys and all verification gates enabled." };
}
