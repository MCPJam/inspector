#!/usr/bin/env node
/**
 * Phase gate: decides which phase of the review pipeline to act on for the
 * PR's current head, or that there is nothing to do yet.
 *
 * Runs on every `workflow_run` completion of the phase workflows. A phase is
 * only looked at once every phase before it passed, so a failing test run is
 * triaged before the quality checks, and the adversarial review only runs on
 * a PR whose checks are green.
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, HEAD_SHA, STATE_DIR; PR_NUMBER when the
 * event carries it. Writes `gate.json` and the `proceed`, `phase` and `base`
 * step outputs.
 */
import { appendFileSync } from "node:fs";
import {
  AUTOFIX_TRAILER, MAX_AUTOFIX_ROUNDS, PHASES, githubClient, isEntrypoint, paginate,
  phaseMarker, requireEnv, runEntrypoint, writeState,
} from "./review-common.mjs";

const PASSED = new Set(["success", "neutral", "skipped"]);
const FAILED = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

/** The newest run of each workflow file, keyed by file name. */
export function latestRuns(runs) {
  const latest = new Map();
  for (const run of runs) {
    const file = run.path?.split("/").pop()?.split("@")[0];
    const seen = latest.get(file);
    if (!seen || run.run_number > seen.run_number ||
        (run.run_number === seen.run_number && run.run_attempt > seen.run_attempt)) latest.set(file, run);
  }
  return latest;
}

/** "pass", "fail" or "wait" for one phase. A cancelled run waits for its replacement. */
export function phaseStatus(phase, latest) {
  const runs = phase.workflows.map((file) => latest.get(file));
  if (runs.some((run) => run?.status === "completed" && FAILED.has(run.conclusion))) return "fail";
  if (runs.every((run) => run?.status === "completed" && PASSED.has(run.conclusion))) return "pass";
  return "wait";
}

/** Consecutive autofix commits at the tip of the PR. */
export function autofixRounds(commits) {
  let rounds = 0;
  for (let index = commits.length - 1; index >= 0; index--) {
    if (!new RegExp(`^${AUTOFIX_TRAILER}:`, "m").test(commits[index].commit?.message ?? "")) break;
    rounds++;
  }
  return rounds;
}

/** Whether the tip commit is the bot's autofix for the review phase itself. */
export function tipIsReviewFix(commits) {
  return new RegExp(`^${AUTOFIX_TRAILER}: review$`, "m").test(commits.at(-1)?.commit?.message ?? "");
}

/**
 * The phase to act on: the first one that failed, or the review once all the
 * checks passed. The review is skipped on its own autofix commit, so the bot
 * does not review its fixes in a loop; the checks still run on them. After a
 * CI or quality autofix turns the checks green, the review runs, because no
 * earlier commit was reviewed.
 */
export function decide({ runs, reviewFix, reviewed }) {
  const latest = latestRuns(runs);
  let target = null;
  for (const phase of PHASES) {
    if (phase.workflows.length === 0) {
      target = { phase: phase.id, status: reviewFix ? "skip" : "run" };
      break;
    }
    const status = phaseStatus(phase, latest);
    if (status !== "pass") {
      target = { phase: phase.id, status };
      break;
    }
  }
  if (reviewed.has(target.phase)) return { ...target, status: "done" };
  return target;
}

async function findPr(request, sha) {
  if (process.env.PR_NUMBER) return request(`pulls/${process.env.PR_NUMBER}`);
  const pulls = await request(`commits/${sha}/pulls`);
  const match = pulls.find((pr) => pr.state === "open" && pr.head.sha === sha);
  return match ? request(`pulls/${match.number}`) : null;
}

export async function gate(request, sha, repo) {
  const pr = await findPr(request, sha);
  if (!pr) return { proceed: false, reason: "No open PR has this commit as its head." };
  if (pr.state !== "open" || pr.draft) return { proceed: false, reason: "The PR is closed or a draft." };
  if (pr.head.sha !== sha) return { proceed: false, reason: "The PR has a newer head; its own runs will be gated." };
  if (pr.head.repo?.full_name !== repo) return { proceed: false, reason: "Fork PRs are not reviewed." };

  const [runs, commits, reviews] = await Promise.all([
    paginate(request, `actions/runs?head_sha=${sha}&event=pull_request`, (page) => page.workflow_runs),
    paginate(request, `pulls/${pr.number}/commits`, undefined, 3),
    paginate(request, `pulls/${pr.number}/reviews`),
  ]);
  const reviewed = new Set(PHASES.map((phase) => phase.id).filter((id) => reviews.some((review) =>
    review.user?.type === "Bot" && review.body?.includes(phaseMarker(id, sha)))));
  const rounds = autofixRounds(commits);
  const { phase, status } = decide({ runs, reviewFix: tipIsReviewFix(commits), reviewed });
  const base = { pr: pr.number, sha, headRef: pr.head.ref, phase, status, rounds };
  if (status === "wait") return { ...base, proceed: false, reason: `Waiting for the ${phase} phase to finish.` };
  if (status === "done") return { ...base, proceed: false, reason: `The ${phase} phase was already triaged for this commit.` };
  if (status === "skip") return { ...base, proceed: false, reason: "The head is the review's own autofix; the review ran on the commit before it." };

  const compare = await request(`compare/${pr.base.sha}...${sha}`);
  return {
    ...base, proceed: true, mergeBase: compare.merge_base_commit.sha,
    autofix: rounds < MAX_AUTOFIX_ROUNDS,
    failedRuns: PHASES.find((entry) => entry.id === phase).workflows
      .map((file) => latestRuns(runs).get(file))
      .filter((run) => run && FAILED.has(run.conclusion))
      .map((run) => ({ id: run.id, name: run.name, file: run.path.split("/").pop() })),
  };
}

export async function main(request = githubClient()) {
  requireEnv(["GITHUB_TOKEN", "GITHUB_REPOSITORY", "HEAD_SHA", "STATE_DIR"]);
  const sha = process.env.HEAD_SHA;
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid commit SHA.");
  const result = await gate(request, sha, process.env.GITHUB_REPOSITORY);
  writeState("gate", result);
  console.log(result.proceed ? `Acting on the ${result.phase} phase of PR #${result.pr}.` : result.reason);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      `proceed=${result.proceed}\nphase=${result.phase ?? ""}\nbase=${result.mergeBase ?? ""}\n`);
  }
}

if (isEntrypoint(import.meta.url)) runEntrypoint(main);
