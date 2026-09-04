import type {
  GithubCheckOutagePolicy,
  GithubInstallationBinding,
  InstallationRepo,
} from "@/hooks/useGithubChecksSettings";

/**
 * The repository-picker rules, in one place.
 *
 * Two surfaces offer the same picker — the settings page and the suite's own
 * section — and the rules below are a CONTRACT WITH THE BACKEND rather than a
 * presentation detail: which value selects a repository, what the verified
 * connect is told about it, and when the offered list has gone stale. Written
 * twice, they drift the first time either side gains a field, and the failure
 * mode is not a broken build but a connect that names the wrong installation.
 */

/**
 * A STABLE description of the installations an organization holds.
 *
 * Both surfaces fetch the offerable repositories through an ACTION, which is a
 * one-shot read: nothing re-runs it on its own. What changes its answer is the
 * set of installations bound to the organization, and that arrives on a live
 * query — so this is the signal an effect watches to know the listing on screen
 * has gone stale. Without it, a page that was open across a bind keeps
 * rendering the empty listing it fetched before the account was connected.
 *
 * It cannot be the bindings ARRAY. That comes from a Convex subscription, whose
 * identity changes on every delivery including one that re-sends byte-identical
 * rows, so an effect keyed on it would ask GitHub again on every update. Two
 * things, and only these two, change which repositories the App can reach:
 *
 *   - WHICH installations are bound (`installationRef`), and
 *   - WHAT STATE each one is in (`status`) — `suspended`, `removed` and
 *     `unbound` each stop an installation answering for its repositories, so a
 *     status change matters even though the set is unchanged.
 *
 * Sorted, so row ORDER cannot masquerade as a change. `accountLogin`, `boundAt`
 * and `statusChangedAt` are excluded deliberately: none of them changes what
 * the App can reach, and a key that moves for a reason the listing does not
 * care about is a refetch nobody asked for.
 *
 * `undefined` — the query has not answered yet — returns `null` rather than the
 * empty-set key. "We have not been told" is not "there are none", and a caller
 * that cannot tell them apart would read the first answer as a change.
 */
export function installationBindingsKey(
  bindings: readonly GithubInstallationBinding[] | undefined
): string | null {
  if (bindings === undefined) return null;
  return bindings
    .map((binding) => `${binding.installationRef}:${binding.status}`)
    .sort()
    .join("|");
}

/**
 * Find the entry a picker value refers to.
 *
 * The value is the NUMERIC REPOSITORY ID as a string, not the name. Two
 * connected accounts can each have a `widgets`, and the id is what the connect
 * is actually keyed on — selecting by name would make the account label merely
 * decorative and let one pick resolve to the other account's repository.
 */
export function findRepoByPickerValue(
  repos: readonly InstallationRepo[],
  value: string
): InstallationRepo | undefined {
  return repos.find((repo) => String(repo.repositoryId) === value);
}

/** The value a picker option carries for one entry. */
export function pickerValueFor(repo: InstallationRepo): string {
  return String(repo.repositoryId);
}

/**
 * Should options carry their GitHub account?
 *
 * Only when it DISAMBIGUATES. With one connected account every option would
 * carry the same suffix, which is a column of noise; with several, `widgets`
 * and `widgets` are genuinely two repositories and the name alone cannot say
 * which is which.
 */
export function shouldShowAccountLabels(
  repos: readonly InstallationRepo[]
): boolean {
  const logins = new Set(
    repos
      .map((repo) => repo.accountLogin)
      .filter((login): login is string => Boolean(login))
  );
  return logins.size > 1;
}

/** What one option reads as. */
export function pickerLabelFor(
  repo: InstallationRepo,
  showAccountLabels: boolean
): string {
  return showAccountLabels && repo.accountLogin
    ? `${repo.fullName} · ${repo.accountLogin}`
    : repo.fullName;
}

/**
 * The arguments the verified connect is given for one picked repository.
 *
 * `installationRef` and `repositoryId` come STRAIGHT OFF the listing entry and
 * are never reassembled: the reference says which installation the repository
 * was enumerated through, the id says which repository it is, and the server
 * re-verifies both. The reference is omitted — not sent as `undefined` — when
 * the entry carries none, which is how an organization still being listed
 * through the backend's pinned installation keeps the compatibility connect
 * reachable.
 */
export function verifiedConnectArgs(
  repo: InstallationRepo,
  target: {
    projectId: string;
    suiteId: string;
    outagePolicy: GithubCheckOutagePolicy;
  }
): {
  repoFullName: string;
  projectId: string;
  suiteId: string;
  outagePolicy: GithubCheckOutagePolicy;
  installationRef?: string;
  repositoryId: number;
} {
  return {
    repoFullName: repo.fullName,
    projectId: target.projectId,
    suiteId: target.suiteId,
    outagePolicy: target.outagePolicy,
    ...(repo.installationRef ? { installationRef: repo.installationRef } : {}),
    repositoryId: repo.repositoryId,
  };
}
