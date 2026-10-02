/**
 * Whether a commit on `main` should start Release now (release-trigger.yml).
 *
 * Release ships a commit only once Tests, Build and Test and Deploy Staging
 * have all passed on it. Every later commit on `main` carries the versions the
 * version PR committed, so when one commit cannot be released (its runs were
 * cancelled by the next push, or a check failed) the next green one is.
 *
 * Unless the version PR ticked skip_verify: then the checks are not waited
 * for, and the version commit itself is released as soon as it lands.
 */

/** Workflow files that must each have a successful run on the commit. */
export const REQUIRED_CHECKS = ["test.yml", "lint.yml", "deploy-staging.yml"];

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
 * @param {string} state.headSha      the commit whose check just passed
 * @param {string} state.mainSha      the tip of `main` now
 * @param {string[]} state.greenChecks REQUIRED_CHECKS entries with a successful run on headSha
 * @param {{name: string, newVersion: string}[]} state.unpublished
 * @param {{status: string, conclusion: string | null, displayTitle: string}[]} state.releaseRuns
 *   recent release.yml runs, newest first
 * @param {boolean} [state.skipVerify] the merged version PR ticked skip_verify
 */
export function decideRelease({
  headSha,
  mainSha,
  greenChecks,
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

  const waiting = REQUIRED_CHECKS.filter((w) => !greenChecks.includes(w));
  if (!skipVerify && waiting.length > 0)
    return skip(`Waiting on ${waiting.join(", ")} for ${headSha}.`);

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
      `The automatic release of ${label} ended "${last.conclusion}". Re-run its failed jobs or start Release from Soundcheck.`
    );

  return {
    dispatch: true,
    label,
    reason: `Releasing ${label} at ${headSha}${skipVerify ? " without waiting for checks (skip_verify)" : ""}.`,
  };
}
