/**
 * Release Verdict strip. Answers "where is the release, and what do I do
 * next?" in one glance, before the operator reads anything else below it.
 *
 * Inputs, in priority order (see lib/release-state.ts for the stages):
 *   1. Is a release.yml run already in flight? → In flight.
 *   2. Does main carry versions npm does not have? Start release pushed them
 *      and its Release run stood down or failed; release-trigger.yml retries
 *      at the first commit where deploy-staging.yml passes.
 *   3. Are there pending changesets? → Go: "Start release" versions and ships.
 *
 * Release waits for staging and runs the full tests itself, so neither is a
 * reason not to start.
 *
 * This component does its own fetches rather than reading from the readiness
 * tile, so the verdict renders even if the readiness tile is still streaming.
 */

import {
  findSuccessfulRunForSha,
  getBranchHead,
  listWorkflowRuns
} from "@/lib/github";
import { fetchPendingChangesets } from "@/lib/changesets";
import {
  automaticReleaseRun,
  fetchUnpublishedVersions,
  releaseLabel
} from "@/lib/release-state";
import { shortSha } from "@/lib/format";
import { Card, CardContent } from "@mcpjam/design-system/card";
import { Verdict } from "@/components/ui";

const INSPECTOR = { owner: "MCPJam", repo: "inspector" };

export function ReleaseVerdictSkeleton() {
  return (
    <Card className="py-5">
      <CardContent className="px-5 md:px-6">
        <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Release verdict
        </div>
        <div className="mt-2 flex items-baseline gap-3">
          <span className="text-2xl md:text-3xl font-semibold text-muted-foreground">
            Reading…
          </span>
          <span className="text-sm text-muted-foreground">
            Checking main &amp; staging
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export async function ReleaseVerdict() {
  // 1. Active release run?
  try {
    const [inProgress, queued] = await Promise.all([
      listWorkflowRuns(INSPECTOR.owner, INSPECTOR.repo, "release.yml", {
        status: "in_progress",
        perPage: 1,
        revalidate: 10
      }),
      listWorkflowRuns(INSPECTOR.owner, INSPECTOR.repo, "release.yml", {
        status: "queued",
        perPage: 1,
        revalidate: 10
      })
    ]);
    const active = inProgress[0] ?? queued[0];
    if (active) {
      return (
        <Verdict
          tone="running"
          headline="A release is already running."
          detail={`release.yml is ${inProgress[0] ? "in progress" : "queued"} on ${shortSha(active.headSha)}${active.actor ? ` — triggered by ${active.actor}` : ""}. Watch the stepper below.`}
        />
      );
    }
  } catch {
    /* fall through — we still want to render a verdict if this single read fails */
  }

  // 2–4. Where main stands.
  let headSha: string | null = null;
  try {
    const head = await getBranchHead(
      INSPECTOR.owner,
      INSPECTOR.repo,
      "main"
    );
    headSha = head.sha;
  } catch (err) {
    return (
      <Verdict
        tone="warning"
        headline="Can't read main."
        detail={(err as Error).message}
      />
    );
  }

  // Fetch errors stay distinct from "nothing there": both would render as
  // "nothing to release" otherwise, and a silent API failure would let the
  // verdict confidently lie.
  const [unpublishedResult, changesetsResult] = await Promise.all([
    fetchUnpublishedVersions(INSPECTOR.owner, INSPECTOR.repo, headSha)
      .then((list) => ({ kind: "ok" as const, list }))
      .catch((err: unknown) => ({
        kind: "error" as const,
        message: (err as Error).message
      })),
    fetchPendingChangesets(INSPECTOR.owner, INSPECTOR.repo, headSha)
      .then((list) => ({ kind: "ok" as const, list }))
      .catch((err: unknown) => ({
        kind: "error" as const,
        message: (err as Error).message
      }))
  ]);

  if (unpublishedResult.kind === "error") {
    return (
      <Verdict
        tone="warning"
        headline="Can't tell whether main carries unreleased versions."
        detail={unpublishedResult.message}
      />
    );
  }

  const unpublished = unpublishedResult.list;
  if (unpublished.length > 0) {
    const label = releaseLabel(unpublished);
    const runs = await listWorkflowRuns(
      INSPECTOR.owner,
      INSPECTOR.repo,
      "release.yml",
      { perPage: 20, revalidate: 10 }
    ).catch(() => []);
    const last = automaticReleaseRun(runs, unpublished);
    if (
      last &&
      last.status === "completed" &&
      last.conclusion !== "success"
    ) {
      return (
        <Verdict
          tone="failure"
          headline={`The release of ${label} ended "${last.conclusion}".`}
          detail="It will not be retried by itself. Fix the cause, then use Publish below. Re-running failed jobs in GitHub does not publish."
        />
      );
    }

    const stagingRun = await findSuccessfulRunForSha(
      INSPECTOR.owner,
      INSPECTOR.repo,
      "deploy-staging.yml",
      "main",
      headSha
    ).catch(() => null);
    return (
      <Verdict
        tone="running"
        headline={`${label} is on main and waiting for staging.`}
        detail={
          stagingRun
            ? `Staging is green on ${shortSha(headSha)}, so Release should start within a minute. It runs the full tests before publishing.`
            : `Release starts by itself once staging deploys and passes its smoke test on the latest commit (now ${shortSha(headSha)}). It then runs the full tests before publishing.`
        }
      />
    );
  }

  if (changesetsResult.kind === "error") {
    return (
      <Verdict
        tone="warning"
        headline="Can't read pending changesets."
        detail={`The changeset lookup failed: ${changesetsResult.message}. Check the readiness tile below.`}
      />
    );
  }

  const changesets = changesetsResult.list;
  if (changesets.length === 0) {
    return (
      <Verdict
        tone="neutral"
        headline="Nothing to release."
        detail={`No pending changesets on main at ${shortSha(headSha)}.`}
      />
    );
  }

  const pkgCount = new Set(
    changesets.flatMap((c) => Object.keys(c.bumps))
  ).size;
  return (
    <Verdict
      tone="success"
      headline="Ready to start a release."
      detail={`${changesets.length} pending changeset${changesets.length === 1 ? "" : "s"} across ${pkgCount} package${pkgCount === 1 ? "" : "s"}. Start release versions them and ships in one run.`}
    />
  );
}
