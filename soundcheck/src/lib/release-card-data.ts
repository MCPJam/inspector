/**
 * Every read the release card needs, in one parallel pass. Each live fact
 * fails on its own: a slow npm or a down hosted app shows "unknown" on that
 * fact instead of blanking the card.
 */

import {
  getBranchHead,
  getLatestRelease,
  listWorkflowRuns,
  type LatestRelease
} from "@/lib/github";
import {
  buildReleasePlan,
  fetchCurrentVersions,
  fetchPendingChangesets,
  type ReleasePlan
} from "@/lib/changesets";
import { fetchUnpublishedVersions } from "@/lib/release-state";
import {
  deriveReleaseStatus,
  typicalReleaseMinutes,
  type ReleaseStatus
} from "@/lib/release-status";

const OWNER = "MCPJam";
const REPO = "inspector";
const HOSTED_HEALTH_URL = "https://app.mcpjam.com/health";
const NPM_LATEST_URL = "https://registry.npmjs.org/@mcpjam%2finspector/latest";

export interface ReleaseCardData {
  status: ReleaseStatus;
  plan: ReleasePlan | null;
  typicalMinutes: number | null;
  live: {
    npm: string | null;
    hosted: string | null;
    /** Latest GitHub release tag when it carries desktop builds. */
    desktop: string | null;
  };
  lastRelease: LatestRelease | null;
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

async function readVersion(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { next: { revalidate: 60 } });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch (err) {
    // One live fact; the card shows "unknown" for it.
    console.error(`release card: ${url} read failed:`, err);
    return null;
  }
}

function hasDesktopBuilds(release: LatestRelease): boolean {
  return release.assetNames.some((n) => /\.(dmg|exe|msi)$/i.test(n));
}

export async function readReleaseCard(): Promise<ReleaseCardData> {
  const active = (workflow: string, status: string) =>
    listWorkflowRuns(OWNER, REPO, workflow, { status, perPage: 1, revalidate: 10 }).then(
      (runs) => runs[0] ?? null
    );
  const [activeRuns, recentRuns, head, npm, hosted, lastRelease] = await Promise.all([
    // A failed read here must not look like "no release running": the button
    // would offer a second one.
    Promise.all([
      active("release.yml", "in_progress"),
      active("release.yml", "queued"),
      active("prepare-release.yml", "in_progress"),
      active("prepare-release.yml", "queued")
    ]).catch(asError),
    listWorkflowRuns(OWNER, REPO, "release.yml", { perPage: 20, revalidate: 10 }).catch(asError),
    getBranchHead(OWNER, REPO, "main").catch(asError),
    readVersion(NPM_LATEST_URL),
    readVersion(HOSTED_HEALTH_URL),
    getLatestRelease(OWNER, REPO).catch((err: unknown) => {
      console.error("release card: latest release read failed:", err);
      return null;
    })
  ]);

  let unpublished: Awaited<ReturnType<typeof fetchUnpublishedVersions>> | Error;
  let plan: ReleasePlan | Error;
  if (head instanceof Error) {
    unpublished = head;
    plan = head;
  } else {
    [unpublished, plan] = await Promise.all([
      fetchUnpublishedVersions(OWNER, REPO, head.sha).catch(asError),
      Promise.all([
        fetchPendingChangesets(OWNER, REPO, head.sha),
        fetchCurrentVersions(OWNER, REPO, head.sha)
      ])
        .then(([changesets, currentVersions]) =>
          buildReleasePlan({ changesets, currentVersions })
        )
        .catch(asError)
    ]);
  }

  const runsError = [activeRuns, recentRuns].find((r) => r instanceof Error);
  const runs = recentRuns instanceof Error ? [] : recentRuns;
  const [releaseRunning, releaseQueued, prepareRunning, prepareQueued] =
    activeRuns instanceof Error ? [null, null, null, null] : activeRuns;

  return {
    status: runsError
      ? { kind: "unknown", reason: runsError.message }
      : deriveReleaseStatus({
          activeRelease: releaseRunning ?? releaseQueued,
          activePrepare: prepareRunning ?? prepareQueued,
          unpublished,
          plan,
          recentRuns: runs,
          now: Date.now()
        }),
    plan: plan instanceof Error ? null : plan,
    typicalMinutes: typicalReleaseMinutes(runs),
    live: {
      npm,
      hosted,
      desktop: lastRelease && hasDesktopBuilds(lastRelease) ? lastRelease.tag.replace(/^v/, "") : null
    },
    lastRelease
  };
}
