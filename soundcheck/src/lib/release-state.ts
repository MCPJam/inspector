/**
 * Reads which release versions on `main` npm does not have yet, for the
 * release card (see release-status.ts for how that becomes a status).
 *
 * A release goes through two states on `main`:
 *
 *   1. Pending changesets. "Start release" dispatches prepare-release.yml,
 *      which versions them, pushes the version commit to `main` and starts
 *      release.yml on it.
 *   2. `main` carries versions npm does not have yet. release.yml waits for
 *      Deploy Staging and runs the full tests, then publishes them. If that
 *      run stood down, release-trigger.yml dispatches it again at the first
 *      commit where Deploy Staging is green.
 *
 * Hand-synced with .github/scripts (release-commit.mjs, release-trigger.mjs,
 * unpublished-versions.mjs): Soundcheck only sees the GitHub API, never the
 * checkout, so it cannot import them.
 */

import { getRepoFile } from "@/lib/github";
import type { UnpublishedVersion } from "@/lib/release-status";

/** The packages release.yml plans for. */
const RELEASE_PACKAGE_DIRS = ["evaluators", "sdk", "cli", "mcpjam-inspector"];

/**
 * Packages whose version at `ref` npm does not have. Throws on any registry
 * answer other than 200 or 404, so a registry outage never reads as
 * "nothing to release".
 */
export async function fetchUnpublishedVersions(
  owner: string,
  repo: string,
  ref: string
): Promise<UnpublishedVersion[]> {
  const found = await Promise.all(
    RELEASE_PACKAGE_DIRS.map(async (dir) => {
      const { name, version } = JSON.parse(
        await getRepoFile(owner, repo, `${dir}/package.json`, ref)
      ) as { name: string; version: string };
      const res = await fetch(
        `https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`,
        { next: { revalidate: 60 } }
      );
      if (res.status === 404) return { name, newVersion: version };
      if (!res.ok) {
        throw new Error(`npm registry ${res.status} for ${name}@${version}`);
      }
      return null;
    })
  );
  return found.filter((v): v is UnpublishedVersion => v !== null);
}
