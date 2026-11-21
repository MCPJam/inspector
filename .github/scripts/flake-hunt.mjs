// Finds the tests that fail CI and then pass when the same commit runs again.
//
//   node .github/scripts/flake-hunt.mjs [--days 14] [--workflow test.yml]...
//       [--repo MCPJam/inspector] [--cache <dir>] [--top 20] [--json]
//       [--max-calls 1000]
//
// It reads GitHub Actions runs through `gh api`, groups every attempt of every
// run by workflow and head SHA, and treats a job that failed on one try and
// passed on a later try of the same commit as flaked. It downloads those
// jobs' logs, pulls out the failing Vitest and Playwright tests, and ranks
// them by how many flaked jobs they appeared in.
//
// Logs, finished attempts' job lists and older days' run lists are cached
// under --cache (default: <tmpdir>/mcpjam-flake-hunt), so a second run costs
// only the run lists of the last two days. --max-calls stops the hunt before
// it spends more of the shared 5,000-an-hour API limit; the report then says
// it is partial.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findFlakedJobs, firstError, formatReport, parseFailures, rankFlakes } from "./flake-hunt-report.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
// A day's run list can still change while its runs are being retried.
const RECENT_DAY_TTL_MS = 60 * 60 * 1000;

export function parseArgs(argv) {
  const options = {
    days: 14,
    workflows: [],
    repo: "MCPJam/inspector",
    cache: join(tmpdir(), "mcpjam-flake-hunt"),
    top: 20,
    json: false,
    maxCalls: 1000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    const number = () => {
      const parsed = Number(value());
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} needs a positive whole number`);
      return parsed;
    };
    if (flag === "--days") options.days = number();
    else if (flag === "--workflow") options.workflows.push(value());
    else if (flag === "--repo") options.repo = value();
    else if (flag === "--cache") options.cache = value();
    else if (flag === "--top") options.top = number();
    else if (flag === "--max-calls") options.maxCalls = number();
    else if (flag === "--json") options.json = true;
    else throw new Error(`Unknown option ${flag}`);
  }
  if (options.workflows.length === 0) options.workflows.push("test.yml");
  return options;
}

class BudgetSpent extends Error {}

/** `gh api` with a call counter that refuses to pass `maxCalls`. */
export function createGitHub({ maxCalls, run = runGh }) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async api(path) {
      if (calls >= maxCalls) throw new BudgetSpent(`spent the ${maxCalls}-call budget`);
      calls += 1;
      return run(["api", path]);
    },
    async json(path) {
      return JSON.parse(await this.api(path));
    },
  };
}

function runGh(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(`gh ${args.join(" ")} exited ${code}: ${Buffer.concat(err).toString("utf8").trim()}`));
    });
  });
}

function createCache(root) {
  for (const dir of ["runs", "jobs", "logs"]) mkdirSync(join(root, dir), { recursive: true });
  return {
    read(kind, key, maxAgeMs = Infinity) {
      const path = join(root, kind, key);
      if (!existsSync(path)) return null;
      if (Date.now() - statSync(path).mtimeMs > maxAgeMs) return null;
      return readFileSync(path, "utf8");
    },
    write(kind, key, text) {
      writeFileSync(join(root, kind, key), text);
    },
  };
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The UTC days from `days` ago to today, oldest first. */
export function windowDays(days, now = Date.now()) {
  return Array.from({ length: days + 1 }, (_, index) => isoDay(now - (days - index) * DAY_MS));
}

// The run list endpoint returns at most 1,000 runs per query, so the window
// is read one day at a time.
async function listRuns(github, cache, { repo, workflow, day, today }) {
  const key = `${workflow.replace(/[^\w.-]/g, "_")}-${day}.json`;
  const ageLimit = Date.parse(today) - Date.parse(day) > 2 * DAY_MS ? Infinity : RECENT_DAY_TTL_MS;
  const cached = cache.read("runs", key, ageLimit);
  if (cached) return JSON.parse(cached);
  const runs = [];
  for (let page = 1; ; page += 1) {
    const body = await github.json(
      `repos/${repo}/actions/workflows/${workflow}/runs?created=${day}..${day}&per_page=100&page=${page}`,
    );
    if (body.total_count > 1000) {
      process.stderr.write(`warning: ${workflow} has ${body.total_count} runs on ${day}; GitHub lists only 1,000\n`);
    }
    runs.push(
      ...body.workflow_runs.map((run) => ({
        id: run.id,
        workflow,
        headSha: run.head_sha,
        attempt: run.run_attempt,
        status: run.status,
        conclusion: run.conclusion,
        createdAt: run.created_at,
        url: run.html_url,
      })),
    );
    if (body.workflow_runs.length < 100 || runs.length >= Math.min(body.total_count, 1000)) break;
  }
  cache.write("runs", key, JSON.stringify(runs));
  return runs;
}

async function listJobs(github, cache, repo, runId, attempt) {
  const key = `${runId}-${attempt}.json`;
  const cached = cache.read("jobs", key);
  if (cached) return JSON.parse(cached);
  const jobs = [];
  for (let page = 1; ; page += 1) {
    const body = await github.json(
      `repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
    );
    jobs.push(
      ...body.jobs.map((job) => ({
        id: job.id,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        url: job.html_url,
        completedAt: job.completed_at,
      })),
    );
    if (body.jobs.length < 100 || jobs.length >= body.total_count) break;
  }
  if (jobs.every((job) => job.status === "completed")) cache.write("jobs", key, JSON.stringify(jobs));
  return jobs;
}

async function jobLog(github, cache, repo, jobId) {
  const key = `${jobId}.log`;
  const cached = cache.read("logs", key);
  if (cached !== null) return cached;
  let text;
  try {
    text = await github.api(`repos/${repo}/actions/jobs/${jobId}/logs`);
  } catch (error) {
    // GitHub drops some jobs' logs; the job still counts, under this reason.
    const gone = /HTTP (404|410)/.exec(error.message);
    if (!gone) throw error;
    text = `##[error]log unavailable (HTTP ${gone[1]})
`;
  }
  cache.write("logs", key, text);
  return text;
}

// Every attempt of every run on one commit, for the commits CI tried more
// than once. A final attempt that succeeded needs no job list: all its jobs
// passed.
async function triesPerCommit(github, cache, repo, runs) {
  const groups = new Map();
  for (const run of runs) {
    if (run.status !== "completed") continue;
    const key = `${run.workflow}\u0000${run.headSha}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const retried = [...groups.values()].filter(
    (group) => group.length > 1 || group[0].attempt > 1,
  );
  const commits = [];
  for (const group of retried) {
    const tries = [];
    for (const run of group) {
      for (let attempt = 1; attempt <= run.attempt; attempt += 1) {
        const final = attempt === run.attempt;
        if (final && run.conclusion === "success") {
          tries.push({ runId: run.id, attempt, createdAt: run.createdAt, conclusion: "success", jobs: null });
        } else if (final && run.conclusion !== "failure" && run.conclusion !== "timed_out") {
          continue;
        } else {
          const jobs = await listJobs(github, cache, repo, run.id, attempt);
          tries.push({ runId: run.id, attempt, createdAt: run.createdAt, conclusion: null, jobs });
        }
      }
    }
    commits.push({ workflow: group[0].workflow, tries });
  }
  return commits;
}

export async function hunt(options, github = createGitHub(options)) {
  const cache = createCache(options.cache);
  const days = windowDays(options.days);
  const today = days.at(-1);
  const runs = [];
  const commits = [];
  const events = [];
  let budgetHit = false;
  try {
    for (const workflow of options.workflows) {
      for (const day of days) runs.push(...(await listRuns(github, cache, { repo: options.repo, workflow, day, today })));
    }
    commits.push(...(await triesPerCommit(github, cache, options.repo, runs)));
    const flaked = commits.flatMap(({ workflow, tries }) =>
      findFlakedJobs(tries).map((flake) => ({ ...flake, workflow })),
    );
    // One at a time: several `gh` processes at once can exhaust a Windows
    // machine's resources, and each finished log stays counted on a budget stop.
    for (const { job, workflow } of flaked) {
      const log = await jobLog(github, cache, options.repo, job.id);
      events.push({
        url: job.url,
        jobName: job.name,
        workflow,
        date: job.completedAt ?? "",
        failures: parseFailures(log),
        error: firstError(log),
      });
    }
  } catch (error) {
    if (!(error instanceof BudgetSpent)) throw error;
    budgetHit = true;
  }
  const summary = {
    repo: options.repo,
    since: days[0],
    until: today,
    workflows: options.workflows,
    runs: runs.filter((run) => run.status === "completed").length,
    retriedCommits: commits.length,
    flakedJobs: events.length,
    apiCalls: github.calls,
    budgetHit,
  };
  return { summary, ranking: rankFlakes(events), events };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const limits = JSON.parse(await runGh(["api", "rate_limit"])).resources.core;
  if (limits.remaining < options.maxCalls) {
    throw new Error(
      `Only ${limits.remaining} GitHub API calls left this hour (resets ${new Date(limits.reset * 1000).toISOString()}); lower --max-calls or wait.`,
    );
  }
  const { summary, ranking } = await hunt(options);
  process.stdout.write(
    options.json
      ? `${JSON.stringify({ summary, ...ranking }, null, 2)}\n`
      : `${formatReport(ranking, summary, { top: options.top })}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
