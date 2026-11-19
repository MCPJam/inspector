/**
 * Whether a commit on `main` should start Release now (release-trigger.yml).
 *
 * Start release dispatches Release itself; this is the fallback for a run that
 * stood down because `main` moved. The trigger waits for one thing: Deploy
 * Staging passing on the commit. Release itself then runs the full test suite
 * and build before it publishes anything. Every later commit on `main` carries
 * the versions Start release committed, so when one commit cannot be released
 * (its staging run was cancelled by the next push, or failed) the next green
 * one is.
 */

/** `unpublished` is unpublished-versions.mjs output: `{ name, newVersion }`. */
export function releaseLabel(unpublished) {
  const inspector = unpublished.find((r) => r.name === "@mcpjam/inspector");
  return inspector
    ? inspector.newVersion
    : unpublished.map((r) => `${r.name} ${r.newVersion}`).join(", ");
}

/** Must match release.yml's `run-name` for a dispatch that sets `versions`. */
export function releaseRunName(label) {
  return `Release ${label}`;
}

/**
 * @param {object} state
 * @param {string} state.headSha      the commit staging just passed on, or that was pushed
 * @param {string} state.mainSha      the tip of `main` now
 * @param {boolean} state.stagingGreen Deploy Staging passed on headSha
 * @param {{name: string, newVersion: string}[]} state.unpublished
 * @param {{status: string, conclusion: string | null, displayTitle: string}[]} state.releaseRuns
 *   recent release.yml runs, newest first
 * @param {boolean} [state.skipVerify] the version commit asked for skip_verify
 */
export function decideRelease({
  headSha,
  mainSha,
  stagingGreen,
  unpublished,
  releaseRuns,
  skipVerify = false,
}) {
  const skip = (reason) => ({ dispatch: false, reason });

  // Release runs at the tip of `main`, so it can only ship this commit while
  // it is still the tip. A newer commit's own checks decide for it.
  if (headSha !== mainSha)
    return skip(`main has moved on to ${mainSha}; its own checks decide.`);

  if (unpublished.length === 0)
    return skip("Every public package version on main is already on npm.");

  if (!skipVerify && !stagingGreen)
    return skip(`Waiting on Deploy Staging for ${headSha}.`);

  if (releaseRuns.some((r) => r.status !== "completed"))
    return skip("A Release run is already queued or running.");

  const label = releaseLabel(unpublished);
  // Once per version set. A run that failed or was cancelled stays that way
  // until someone re-runs it or starts one from Soundcheck: retrying on every
  // green commit would repeat a production deploy that already went wrong.
  // A run that succeeded without publishing was a no-op (main moved between
  // this decision and its start), so that one is dispatched again.
  const last = releaseRuns.find((r) => r.displayTitle === releaseRunName(label));
  if (last && last.conclusion !== "success")
    return skip(
      `The automatic release of ${label} ended "${last.conclusion}". Retry it with Retry release in Soundcheck.`
    );

  return {
    dispatch: true,
    label,
    reason: `Releasing ${label} at ${headSha}${skipVerify ? " without waiting for staging (skip_verify)" : ""}.`,
  };
}
