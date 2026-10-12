/**
 * Release Verdict strip. Answers "where is the release, and what do I do
 * next?" in one glance, before the operator reads anything else below it.
 *
 * Inputs, in priority order (see lib/release-state.ts for the stages):
 *   1. Is a release.yml run already in flight? → In flight.
 *   2. Does main carry versions npm does not have? The version PR merged and
 *      Release is waiting for a green main, or its automatic run failed.
 *   3. Is the version PR open? → merge it.
 *   4. Are there pending changesets? → Go: "Start release" opens the PR.
 *
 * The CI and staging gates only matter in (2): release-trigger.yml starts
 * Release at the first commit where test.yml, lint.yml and deploy-staging.yml
 * all passed, so they say how long the wait is, not whether to start.
 *
 * This component does its own fetches rather than reading from the readiness
 * tile, so the verdict renders even if the readiness tile is still streaming.
 */

import {
  findOpenPullRequest,
  findSuccessfulRunForSha,
  getBranchHead,
  listWorkflowRuns
} from "@/lib/github";
import { fetchPendingChangesets } from "@/lib/changesets";
import {
  automaticReleaseRun,
  fetchUnpublishedVersions,
  releaseLabel,
  VERSION_PR_BRANCH
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
  const [unpublishedResult, versionPrResult, changesetsResult] = await Promise.all([
    fetchUnpublishedVersions(INSPECTOR.owner, INSPECTOR.repo, headSha)
      .then((list) => ({ kind: "ok" as const, list }))
      .catch((err: unknown) => ({
        kind: "error" as const,
        message: (err as Error).message
      })),
    findOpenPullRequest(INSPECTOR.owner, INSPECTOR.repo, VERSION_PR_BRANCH, {
      revalidate: 30
    })
      .then((pr) => ({ kind: "ok" as const, pr }))
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
          detail="It will not be retried by itself. Re-run its failed jobs in GitHub, or use Run release now below once the cause is fixed."
        />
      );
    }

    const [stagingRun, testRun, lintRun] = await Promise.all(
      ["deploy-staging.yml", "test.yml", "lint.yml"].map((workflow) =>
        findSuccessfulRunForSha(
          INSPECTOR.owner,
          INSPECTOR.repo,
          workflow,
          "main",
          headSha
        ).catch(() => null)
      )
    );
    const waiting = [
      testRun ? null : "test.yml",
      lintRun ? null : "lint.yml",
      stagingRun ? null : "deploy-staging.yml"
    ].filter((name): name is string => name !== null);
    return (
      <Verdict
        tone="running"
        headline={`${label} is merged and waiting for a green main.`}
        detail={
          waiting.length > 0
            ? `Release starts by itself at the first commit where test.yml, lint.yml and deploy-staging.yml all pass. ${shortSha(headSha)} is waiting on ${waiting.join(", ")}.`
            : `Everything is green on ${shortSha(headSha)}, so Release should start within a minute.`
        }
      />
    );
  }

  if (versionPrResult.kind === "error") {
    return (
      <Verdict
        tone="warning"
        headline="Can't check for an open version PR."
        detail={`${versionPrResult.message}. Soundcheck's GITHUB_PAT needs pull_requests:read.`}
      />
    );
  }

  const versionPr = versionPrResult.pr;
  if (versionPr) {
    return (
      <Verdict
        tone="info"
        headline={`Version PR #${versionPr.number} is waiting for review.`}
        detail={`Approve and merge "${versionPr.title}" to release. Everything after the merge runs by itself.`}
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
      detail={`${changesets.length} pending changeset${changesets.length === 1 ? "" : "s"} across ${pkgCount} package${pkgCount === 1 ? "" : "s"}. Start release opens the version PR.`}
    />
  );
}
