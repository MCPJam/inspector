/**
 * Release Verdict strip. Answers "can I ship right now?" in one glance,
 * before the operator reads anything else below it.
 *
 * Inputs, in priority order:
 *   1. Is a release.yml run already in flight? → In flight.
 *   2. Is inspector main at a SHA with a green deploy-staging.yml?
 *      + Are there pending changesets?  → Go.
 *   3. Otherwise describe the blocker. → Hold / Caution.
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
import { shortSha } from "@/lib/format";
import { Verdict } from "@/components/ui";

const INSPECTOR = { owner: "MCPJam", repo: "inspector" };

export function ReleaseVerdictSkeleton() {
  return (
    <div className="panel p-6 md:p-8">
      <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-ink-500">
        Release verdict
      </div>
      <div className="mt-2 flex items-baseline gap-3">
        <span className="display-hero text-2xl md:text-3xl text-ink-400">
          Reading…
        </span>
        <span className="text-sm text-ink-500">Checking main &amp; staging</span>
      </div>
    </div>
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

  // 2. Staging green for main HEAD + pending changesets?
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

  const [stagingRun, changesets] = await Promise.all([
    findSuccessfulRunForSha(
      INSPECTOR.owner,
      INSPECTOR.repo,
      "deploy-staging.yml",
      "main",
      headSha
    ).catch(() => null),
    fetchPendingChangesets(INSPECTOR.owner, INSPECTOR.repo, headSha).catch(
      () => null
    )
  ]);

  if (!stagingRun) {
    return (
      <Verdict
        tone="failure"
        headline={`Hold — staging isn't green for ${shortSha(headSha)}.`}
        detail="release.yml preflight will refuse until deploy-staging.yml succeeds on this exact SHA. Wait for it, or investigate recent failures below."
      />
    );
  }

  if (!changesets || changesets.length === 0) {
    return (
      <Verdict
        tone="warning"
        headline="No pending changesets on main."
        detail={`Staging is green on ${shortSha(headSha)}, but there's nothing to publish. release.yml preflight will exit with no plan.`}
      />
    );
  }

  const pkgCount = new Set(
    changesets.flatMap((c) => Object.keys(c.bumps))
  ).size;
  return (
    <Verdict
      tone="success"
      headline="Go — all preflight gates are clear."
      detail={`Staging is green on ${shortSha(headSha)}. ${changesets.length} pending changeset${changesets.length === 1 ? "" : "s"} across ${pkgCount} package${pkgCount === 1 ? "" : "s"}. Dispatch when ready.`}
    />
  );
}
