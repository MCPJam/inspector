// Where a release finds local-harness conformance evidence it does not have
// to produce itself.
//
// The evidence run (local-harness-release-evidence.yml) runs the release's
// conformance gate when a commit a release could ship lands on `main`, and a
// release that ran the gate itself leaves the same record. Both upload a
// marker artifact named for the conformance inputs digest and the packs the
// build selects (`releaseEvidenceName`). A release looks the marker up by
// that name, takes the newest run of one of those two workflows that a push
// or a dispatch on this repo's `main` started, and downloads that run's
// `conformance-evidence-*` artifacts.
//
// Anyone can name an artifact anything, so the run is what is trusted, not
// the marker. And the release gate still checks every record it is handed
// (layer digest, pack digest, inputs digest), so the wrong run can only make
// the gate fail, never pass a release it should not.
import { createHash } from "node:crypto";

export const EVIDENCE_RUN_WORKFLOW = "local-harness-release-evidence.yml";

/** The workflows whose runs may hand a release their evidence. */
export const EVIDENCE_WORKFLOWS = Object.freeze([
  `.github/workflows/${EVIDENCE_RUN_WORKFLOW}`,
  ".github/workflows/release.yml",
]);

/** The marker artifact's name for these conformance inputs and packs. */
export function releaseEvidenceName({ digest, packs }) {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`not a conformance inputs digest: ${digest}`);
  if (typeof packs !== "string" || packs.length === 0) throw new Error("the packs the build selects are required");
  const key = createHash("sha256").update(`${digest}\n${packs}`).digest("hex").slice(0, 40);
  return `local-harness-release-evidence-${key}`;
}

/** Whether a release may treat this run's artifacts as its own. */
export function isTrustedEvidenceRun(run, repository) {
  return (
    EVIDENCE_WORKFLOWS.includes(run?.path) &&
    (run.event === "push" || run.event === "workflow_dispatch") &&
    run.head_branch === "main" &&
    run.repository?.full_name === repository &&
    run.head_repository?.full_name === repository
  );
}

const ACTIVE = new Set(["requested", "queued", "pending", "waiting", "in_progress"]);

async function markedRun({ github, owner, repo, name }) {
  const markers = (
    await github.paginate(github.rest.actions.listArtifactsForRepo, { owner, repo, name, per_page: 100 })
  )
    .filter((artifact) => artifact.name === name && !artifact.expired && artifact.workflow_run?.id)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  for (const marker of markers) {
    const { data: run } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: marker.workflow_run.id });
    if (!isTrustedEvidenceRun(run, `${owner}/${repo}`)) continue;
    // The marker outlives its evidence by the minutes between the uploads.
    const evidence = (
      await github.paginate(github.rest.actions.listWorkflowRunArtifacts, { owner, repo, run_id: run.id, per_page: 100 })
    ).filter((artifact) => artifact.name.startsWith("conformance-evidence-"));
    if (evidence.length > 0 && evidence.every((artifact) => !artifact.expired)) return run.id;
  }
  return null;
}

async function activeEvidenceRun({ github, owner, repo, sha }) {
  const { data } = await github.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: EVIDENCE_RUN_WORKFLOW,
    head_sha: sha,
    per_page: 20,
  });
  return data.workflow_runs.find((run) => ACTIVE.has(run.status)) ?? null;
}

/**
 * The id of the run whose evidence covers `name`, or null. With `sha`, waits
 * up to `timeoutMs` while an evidence run for that commit is still going:
 * running the gate again beside it would only compete for the same runners.
 */
export async function findReleaseEvidence({
  github,
  owner,
  repo,
  name,
  sha = null,
  timeoutMs = 0,
  pollMs = 30_000,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const runId = await markedRun({ github, owner, repo, name });
    if (runId !== null) return { runId, reason: `Run ${runId} already has conformance evidence for these inputs and packs.` };
    if (sha === null) return { runId: null, reason: "No run has conformance evidence for these inputs and packs." };
    const active = await activeEvidenceRun({ github, owner, repo, sha });
    if (active === null) {
      return { runId: null, reason: "No run has conformance evidence for these inputs and packs, and none is producing it." };
    }
    if (now() >= deadline) {
      return { runId: null, reason: `Evidence run ${active.id} is still ${active.status} after the wait; running the gate here.` };
    }
    log(`Evidence run ${active.id} for ${sha} is ${active.status}; checking again shortly.`);
    await sleep(pollMs);
  }
}
