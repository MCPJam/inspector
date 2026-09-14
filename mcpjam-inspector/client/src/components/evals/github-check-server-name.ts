/**
 * A GitHub App check has no saved server to run against: the worker builds the
 * pull request's own code in a sandbox and creates a throwaway `servers` row
 * for it, named `gh-check-<triggerId>` (`github-checks-worker.ts`, mirrored by
 * the backend's `ephemeralServerName`).
 *
 * That name is an ownership marker rather than a label — it is the only
 * evidence a row belongs to a check, so it is what authorises reaping it — and
 * the run freezes it into `configSnapshot.environment.servers`. So the Runs
 * table cannot show what it was handed: every check run would add another
 * opaque id to the Server filter, one per pull request, forever.
 *
 * The suite the check ran is bound to real servers, and those are the ones a
 * reader means by "which server". Substituting them here keeps the fix where
 * the problem is — the display — and leaves the stored identity untouched.
 */
const EPHEMERAL_CHECK_SERVER = /^gh-check-[A-Za-z0-9_-]+$/;

/** Shown when the suite's own servers are unknown (see `displayRunServerNames`). */
export const PR_SERVER_LABEL = "PR server";

export function isEphemeralCheckServerName(name: string): boolean {
  return EPHEMERAL_CHECK_SERVER.test(name.trim());
}

/**
 * The server names to SHOW for one run: its own, except that a check's
 * ephemeral server reads as the suite's servers.
 *
 * `suiteServers` empty — the suite is still loading, or it selects its servers
 * through a project environment rather than naming them — falls back to one
 * shared label. Every check run then collapses into a single filter entry,
 * which is still the point: no run-specific ids in the list.
 */
export function displayRunServerNames(
  names: readonly string[],
  suiteServers: readonly string[] = [],
): string[] {
  return [
    ...new Set(
      names.flatMap((name) =>
        isEphemeralCheckServerName(name)
          ? suiteServers.length
            ? [...suiteServers]
            : [PR_SERVER_LABEL]
          : [name],
      ),
    ),
  ];
}
