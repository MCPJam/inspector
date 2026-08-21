import type {
  GithubCheckOutagePolicy,
  InstallationRepo,
} from "@/hooks/useGithubChecksSettings";

/**
 * The repository-picker rules, in one place.
 *
 * Two surfaces offer the same picker — the settings page and the suite's own
 * section — and all three rules below are a CONTRACT WITH THE BACKEND rather
 * than a presentation detail: which value selects a repository, and what the
 * verified connect is told about it. Written twice, they drift the first time
 * either side gains a field, and the failure mode is not a broken build but a
 * connect that names the wrong installation.
 */

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
