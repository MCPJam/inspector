/**
 * Where the release pipeline stands, for the verdict and readiness tiles.
 *
 * A release goes through three states on `main`:
 *
 *   1. Pending changesets. "Start release" dispatches prepare-release.yml,
 *      which versions them and opens the version PR.
 *   2. The version PR is open. Merging it is the release.
 *   3. `main` carries versions npm does not have yet. release-trigger.yml
 *      dispatches release.yml at the first commit where Tests, Build and Test
 *      and Deploy Staging are all green, inside the release window, and
 *      release.yml publishes them.
 *
 * Hand-synced with .github/scripts (release-pr.mjs, release-trigger.mjs,
 * unpublished-versions.mjs): Soundcheck only sees the GitHub API, never the
 * checkout, so it cannot import them.
 */

import { getRepoFile, type WorkflowRun } from "@/lib/github";

/** release-pr.mjs `VERSION_PR_BRANCH`. */
export const VERSION_PR_BRANCH = "release/version-packages";

/** The packages release.yml plans for. */
const RELEASE_PACKAGE_DIRS = ["evaluators", "sdk", "cli", "mcpjam-inspector"];

export interface UnpublishedVersion {
  name: string;
  newVersion: string;
}

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

/** release-trigger.mjs `releaseLabel`. */
export function releaseLabel(unpublished: UnpublishedVersion[]): string {
  const inspector = unpublished.find((r) => r.name === "@mcpjam/inspector");
  return inspector
    ? inspector.newVersion
    : unpublished.map((r) => `${r.name} ${r.newVersion}`).join(", ");
}

/** release-trigger.mjs `RELEASE_WINDOW`. */
export const RELEASE_WINDOW = {
  timeZone: "America/Los_Angeles",
  // Sunday to Friday, as getDay() numbers them.
  days: [0, 1, 2, 3, 4, 5],
  startHour: 17,
  endHour: 21,
  label: "5 PM to 9 PM Pacific, Sunday to Friday"
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** release-trigger.mjs `releaseWindowOpen`. */
export function releaseWindowOpen(date: Date): boolean {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: RELEASE_WINDOW.timeZone,
      weekday: "short",
      hour: "numeric",
      hourCycle: "h23"
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value])
  );
  const hour = Number(parts.hour);
  return (
    RELEASE_WINDOW.days.includes(WEEKDAYS.indexOf(parts.weekday)) &&
    hour >= RELEASE_WINDOW.startHour &&
    hour < RELEASE_WINDOW.endHour
  );
}

/**
 * The trigger's own release.yml run for these versions (it names runs
 * `Release <label>`), newest first in `runs`. The trigger does not retry one
 * that failed or was cancelled, so that is the state to surface.
 */
export function automaticReleaseRun(
  runs: WorkflowRun[],
  unpublished: UnpublishedVersion[]
): WorkflowRun | null {
  const title = `Release ${releaseLabel(unpublished)}`;
  return runs.find((r) => r.displayTitle === title) ?? null;
}
