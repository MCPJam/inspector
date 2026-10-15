#!/usr/bin/env node
/**
 * Collects the feedback for the phase the gate picked: the failed jobs' check
 * annotations and log tails for the CI and quality phases, or the adversarial
 * review's findings once those passed. Also gathers the head blobs triage needs
 * to write fixes: the files the PR changed and the files the logs name.
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, STATE_DIR, REPO_DIR (a checkout holding
 * the PR head and its merge base); ANTHROPIC_API_KEY for the review phase.
 * Reads `gate.json`, writes `feedback.json`, or the `stale` step output when
 * the PR head moved.
 */
import { appendFileSync } from "node:fs";
import { collectContext, ReviewBudgetError, runReview } from "./adversarial-review.mjs";
import {
  githubClient, gitIn, isEntrypoint, paginate, readBlob, readState, requireEnv, runEntrypoint, writeState,
} from "./review-common.mjs";

const LOG_LINES = 400;
const LOG_BYTES = 60_000;
const LOGS_BUDGET = 200_000;
const REFERENCED_BUDGET = 150_000;
const FAILED_JOB = new Set(["failure", "timed_out"]);
const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const NOTES = {
  "pr-size.yml": "PR Size failed: the PR is over the size limit. Only a person can resolve this, by splitting " +
    "the PR or applying the `large-pr` or `mechanical` label, so it is a discuss item with no code change.",
  "ui-copy-review.yml": "UI Copy Review already posted its rewrites as suggestions on the PR. Do not suggest them " +
    "again; autofix one only when it is plainly correct, otherwise leave it to that review.",
};

/** The end of a job log, without timestamps or color codes, where the failure usually is. */
export function logTail(log, maxLines = LOG_LINES, maxBytes = LOG_BYTES) {
  const lines = log.replace(/\r/g, "").split("\n")
    .map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "").replace(ANSI_COLOR, ""));
  const tail = lines.slice(-maxLines).join("\n");
  return tail.length > maxBytes ? tail.slice(-maxBytes) : tail;
}

/** Repository-looking paths a log or annotation mentions, such as `src/a.test.ts:12`. */
export function referencedPaths(texts) {
  const paths = new Set();
  for (const text of texts) {
    for (const match of text.matchAll(/(?:^|[\s'"`(:])((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z]{1,5})\b/g)) {
      const path = match[1].replace(/^\.\//, "");
      if (!path.startsWith("/") && !path.includes("node_modules/") && !path.includes("..")) paths.add(path);
    }
  }
  return [...paths];
}

async function jobFeedback(request, run, job, budget) {
  const annotations = (await request(`check-runs/${job.id}/annotations?per_page=50`))
    .filter((annotation) => annotation.annotation_level !== "notice")
    .map(({ path, start_line: line, message, annotation_level: level }) => ({ path, line, message, level }));
  let log = "";
  let note = NOTES[run.file] ?? "";
  if (budget.left > 0) {
    try {
      log = logTail(await request(`actions/jobs/${job.id}/logs`, { raw: true }), LOG_LINES,
        Math.min(LOG_BYTES, budget.left));
      budget.left -= log.length;
    } catch (error) {
      // Logs expire and can be missing; the annotations still describe the failure.
      note = `${note} The job log could not be read (${error.message}).`.trim();
    }
  }
  return { source: `${run.name} / ${job.name}`, workflow: run.file, annotations, log, note };
}

export async function checkFeedback(request, failedRuns) {
  const items = [];
  const budget = { left: LOGS_BUDGET };
  for (const run of failedRuns) {
    const jobs = await paginate(request, `actions/runs/${run.id}/jobs`, (page) => page.jobs);
    const failed = jobs.filter((job) => FAILED_JOB.has(job.conclusion));
    if (failed.length === 0) {
      const note = NOTES[run.file] ?? "The workflow failed before any job ran.";
      items.push({ source: run.name, workflow: run.file, annotations: [], log: "", note });
    }
    for (const job of failed) items.push(await jobFeedback(request, run, job, budget));
  }
  return items;
}

/** The PR's changed files, plus whole head files the feedback names, within a budget. */
export function gatherFiles(runGit, base, head, items) {
  let files;
  const notes = [];
  try {
    files = collectContext(base, head, runGit);
  } catch (error) {
    if (!(error instanceof ReviewBudgetError)) throw error;
    files = [];
    notes.push("The PR's diff is over the context budget; only files named in the feedback are included.");
  }
  const known = new Set(files.map((file) => file.path));
  let left = REFERENCED_BUDGET;
  const texts = items.flatMap((item) => [item.log ?? "", ...(item.annotations ?? []).map((a) => `${a.path} ${a.message}`)]);
  for (const path of referencedPaths(texts)) {
    if (known.has(path)) continue;
    const blob = readBlob(runGit, head, path);
    if (!blob || blob.content.length > left) continue;
    files.push({ path, before: null, after: blob.content, diff: "", referenced: true });
    known.add(path);
    left -= blob.content.length;
  }
  return { files, notes };
}

export async function collectFeedback({ gate, request, runGit, call }) {
  if (gate.phase === "review") {
    const review = await runReview({ base: gate.mergeBase, head: gate.sha, runGit, call });
    const items = review.findings.map((finding) => ({ source: "Adversarial review", ...finding }));
    return { phase: gate.phase, verdict: review.verdict, summary: review.summary, notes: review.notes, items, files: review.files };
  }
  const items = await checkFeedback(request, gate.failedRuns);
  const { files, notes } = gatherFiles(runGit, gate.mergeBase, gate.sha, items);
  const summary = `Failed: ${gate.failedRuns.map((run) => run.name).join(", ")}.`;
  return { phase: gate.phase, verdict: "FAILED", summary, notes, items, files };
}

/**
 * Runs for one commit are not cancelled by a push (they are grouped by SHA),
 * so check the PR still points here before paying for the Claude calls.
 */
export async function headMoved(request, gate) {
  const current = await request(`pulls/${gate.pr}`);
  return current.state !== "open" || current.head.sha !== gate.sha;
}

export async function main() {
  requireEnv(["GITHUB_TOKEN", "GITHUB_REPOSITORY", "STATE_DIR", "REPO_DIR"]);
  const gate = readState("gate");
  const request = githubClient();
  if (await headMoved(request, gate)) {
    console.log("::notice::The PR moved on since this run started; the new head gets its own run.");
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "stale=true\n");
    return;
  }
  if (gate.phase === "review") requireEnv(["ANTHROPIC_API_KEY"]);
  const feedback = await collectFeedback({ gate, request, runGit: gitIn(process.env.REPO_DIR) });
  writeState("feedback", feedback);
  console.log(`${feedback.items.length} feedback items for the ${gate.phase} phase.`);
}

if (isEntrypoint(import.meta.url)) runEntrypoint(main);
