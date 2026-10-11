import { REQUIRED_CHECKS } from "./release-trigger.mjs";

export const DAILY_RELEASE_CHECKS = [...REQUIRED_CHECKS, "dependency-audit.yml"];

/** Only same-repository main runs can authorize a production release. */
function latestRuns(runs, repository) {
  const latest = new Map();
  for (const run of runs) {
    if (run.event !== "push" || run.head_branch !== "main" ||
        run.head_repository?.full_name !== repository) continue;
    const previous = latest.get(run.head_sha);
    if (!previous || run.run_number > previous.run_number ||
        (run.run_number === previous.run_number && run.run_attempt > previous.run_attempt)) {
      latest.set(run.head_sha, run);
    }
  }
  return latest;
}

/** Commits must be main's first-parent history, newest first. */
export function selectDailyCandidate({ commits, runsByWorkflow, repository, now }) {
  if (!Number.isFinite(now)) throw new Error("A valid selection time is required.");
  const checks = DAILY_RELEASE_CHECKS.map((workflow) => {
    if (!Array.isArray(runsByWorkflow[workflow])) {
      throw new Error(`Missing workflow evidence: ${workflow}`);
    }
    return latestRuns(runsByWorkflow[workflow], repository);
  });
  const commit = commits.find(({ sha }) => checks.every((runs) => {
    const run = runs.get(sha);
    return run?.status === "completed" && run.conclusion === "success";
  }));
  if (!commit) throw new Error("No merged commit passed all daily release checks in the inspected history.");
  const committedAt = Date.parse(commit.committedAt);
  if (!/^[a-f0-9]{40}$/.test(commit.sha) || !Number.isFinite(committedAt) || committedAt > now) {
    throw new Error("The selected commit has an invalid SHA or commit timestamp.");
  }
  const ageHours = (now - committedAt) / 3_600_000;
  return {
    sha: commit.sha,
    committedAt: commit.committedAt,
    ageHours,
    stale: ageHours > 12,
    evidence: checks.map((runs) => runs.get(commit.sha).html_url),
  };
}

/** Bound history reads, and stop with an error instead of guessing on an API failure. */
export async function readDailyCandidate({ github, context, commits, now }) {
  const entries = await Promise.all(DAILY_RELEASE_CHECKS.map(async (workflow_id) => {
    const runs = [];
    const pages = github.paginate.iterator(github.rest.actions.listWorkflowRuns, {
      ...context.repo, workflow_id, per_page: 100,
    });
    let count = 0;
    for await (const { data } of pages) {
      runs.push(...data);
      if (++count === 5) break;
    }
    return [workflow_id, runs];
  }));
  return selectDailyCandidate({
    commits,
    runsByWorkflow: Object.fromEntries(entries),
    repository: `${context.repo.owner}/${context.repo.repo}`,
    now,
  });
}

export function staleCandidateMessage(candidate, repository, runUrl) {
  return `Daily full release: the newest healthy merged commit is ${candidate.ageHours.toFixed(1)} hours old ` +
    `(committed ${candidate.committedAt}).\n` +
    `<https://github.com/${repository}/commit/${candidate.sha}|Selected commit ${candidate.sha.slice(0, 12)}>\n` +
    `Age alone does not block release; versioning and release checks still apply.\n<${runUrl}|Scheduled run>`;
}
