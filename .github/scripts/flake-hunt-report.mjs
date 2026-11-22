// The pure half of flake-hunt.mjs: which jobs flaked, which tests failed in
// a job log, and the ranking. Nothing here calls GitHub, so the tests feed it
// fixture text.

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** A log line without colour codes or the runner's timestamp prefix. */
export function cleanLine(line) {
  return line.replace(ANSI, "").replace(TIMESTAMP, "").replace(/\r$/, "");
}

const FAILED_JOB = new Set(["failure", "timed_out"]);

/**
 * The failed jobs that passed on a later try of the same commit.
 *
 * `tries` is every attempt of every run of one workflow and event on one
 * head SHA: `{ runId, attempt, startedAt, jobs }`. Tries are ordered by when
 * the attempt started, since a rerun of an older run can start after a newer
 * run failed. A failed job flaked when a later try ran a job of the same name
 * that passed. A skipped job, or one the later try did not run, proves
 * nothing.
 */
export function findFlakedJobs(tries) {
  const ordered = [...tries].sort(
    (a, b) => a.startedAt.localeCompare(b.startedAt) || a.attempt - b.attempt,
  );
  const flaked = [];
  ordered.forEach((attemptRecord, index) => {
    const later = ordered.slice(index + 1);
    for (const job of attemptRecord.jobs) {
      if (!FAILED_JOB.has(job.conclusion)) continue;
      const passedBy = later.find((other) =>
        other.jobs.some(
          (otherJob) =>
            otherJob.name === job.name && otherJob.conclusion === "success",
        ),
      );
      if (passedBy) {
        flaked.push({
          job,
          runId: attemptRecord.runId,
          attempt: attemptRecord.attempt,
          passedOn: { runId: passedBy.runId, attempt: passedBy.attempt },
        });
      }
    }
  });
  return flaked;
}

// Parts of an error message that change between runs of the same failure.
function normalizeMessage(message) {
  return message
    .replace(/\b0x[0-9a-f]+\b/gi, "0x…")
    .replace(/\b\d{4,}\b/g, "N")
    .trim();
}

// ` FAIL  client  src/a.test.tsx > Suite > name`, with the project shown as a
// padded label or as `|client|`, or absent. A file that failed to load prints
// ` FAIL  client  src/a.test.tsx [ src/a.test.tsx ]`.
function parseVitestFail(line) {
  const match = /^\s*FAIL\s+(.*)$/.exec(line);
  if (!match) return null;
  let rest = match[1].trim();
  let project = null;
  const piped = /^\|([^|]+)\|\s+(.*)$/.exec(rest);
  if (piped) {
    project = piped[1].trim();
    rest = piped[2];
  } else {
    const labelled = /^(\S+)\s+(\S+.*)$/.exec(rest);
    const firstToken = labelled?.[1] ?? "";
    const secondToken = labelled?.[2].split(/\s/)[0] ?? "";
    if (labelled && !TEST_FILE.test(firstToken) && TEST_FILE.test(secondToken)) {
      project = firstToken;
      rest = labelled[2];
    }
  }
  const parts = rest.split(" > ");
  const projectPath = parts[0].replace(/\s+\[[^\]]*\]$/, "").trim();
  if (!TEST_FILE.test(projectPath)) return null;
  // FAIL paths are relative to the project, whose label is its directory in
  // the Inspector; unhandled errors name the path from the workspace root.
  const file =
    project && !projectPath.startsWith(`${project}/`) ? `${project}/${projectPath}` : projectPath;
  const name = parts.slice(1).join(" > ").replace(/\s+\d+ms$/, "").trim();
  return { kind: "test", project, file, name: name || "(file failed to load)" };
}

// Vitest's "Unhandled Errors" section: each block opens with a
// `⎯⎯ Uncaught Exception ⎯⎯` style banner, then the message, then the file
// it came from.
function parseUnhandled(lines) {
  const found = [];
  let current = null;
  const close = () => {
    if (current?.message) found.push(current);
    current = null;
  };
  for (const line of lines) {
    if (/^⎯+ (Uncaught Exception|Unhandled Rejection|Unhandled Error) ⎯+$/.test(line.trim())) {
      close();
      current = { message: null, file: null, test: null };
      continue;
    }
    if (!current) continue;
    if (/^⎯+$/.test(line.trim()) || /^\s*Test Files\s/.test(line)) {
      close();
      continue;
    }
    if (current.message === null && line.trim()) {
      current.message = normalizeMessage(line);
      continue;
    }
    const origin = /This error originated in "([^"]+)" test file/.exec(line);
    if (origin) current.file = origin[1];
    const latest = /The latest test that might've caused the error is "([^"]+)"/.exec(line);
    if (latest) current.test = latest[1];
  }
  close();
  return found.map(({ message, file, test }) => ({
    kind: "unhandled",
    project: null,
    file: file ?? "(unknown file)",
    name: test ? `${message} (latest test: ${test})` : message,
  }));
}

// Playwright's end summary: `  2 failed` then one `[project] › file:line:col
// › title` line per failure.
function parsePlaywright(lines) {
  const found = [];
  let inFailed = false;
  for (const line of lines) {
    if (/^\s*\d+ failed\s*$/.test(line)) {
      inFailed = true;
      continue;
    }
    if (!inFailed) continue;
    const match = /^\s+\[([^\]]+)\] › (\S+?):\d+:\d+ › (.+?)\s*$/.exec(line);
    if (!match) {
      inFailed = false;
      continue;
    }
    found.push({ kind: "playwright", project: match[1], file: match[2], name: match[3] });
  }
  return found;
}

/**
 * The tests a failed job log names: Vitest `FAIL` lines, Vitest unhandled
 * errors (attributed to the file they came from) and Playwright failures.
 * Each failure appears once even when the log prints it twice.
 */
export function parseFailures(logText) {
  const lines = logText.split("\n").map(cleanLine);
  const failures = [];
  for (const line of lines) {
    const fail = parseVitestFail(line);
    if (fail) failures.push(fail);
  }
  failures.push(...parseUnhandled(lines), ...parsePlaywright(lines));
  const seen = new Set();
  return failures.filter((failure) => {
    const key = failureKey(failure);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The first `##[error]` line of a log: why a job failed when no test did. */
export function firstError(logText) {
  for (const raw of logText.split("\n")) {
    const match = /##\[error\](.*)$/.exec(cleanLine(raw));
    if (match) return normalizeMessage(match[1]);
  }
  return null;
}

export function failureKey({ kind, file, name }) {
  return `${kind}\u0000${file}\u0000${name}`;
}

/**
 * Ranks failures by the number of flaked jobs they appeared in.
 *
 * `events` is one entry per flaked job: `{ url, jobName, workflow, date,
 * failures }`. A job whose log names no test is ranked under its job name and
 * first error, so infrastructure failures still show up.
 */
export function rankFlakes(events, { examples = 3 } = {}) {
  const tests = new Map();
  const files = new Map();
  for (const event of events) {
    const failures = event.failures.length
      ? event.failures
      : [
          {
            kind: "job",
            project: null,
            file: event.jobName,
            name: event.error ?? "(no test failure found in the log)",
          },
        ];
    const fileSeen = new Set();
    for (const failure of failures) {
      const key = failureKey(failure);
      const entry = tests.get(key) ?? {
        ...failure,
        count: 0,
        jobs: new Set(),
        examples: [],
        lastSeen: "",
      };
      entry.count += 1;
      entry.jobs.add(`${event.workflow} / ${event.jobName}`);
      if (entry.examples.length < examples) entry.examples.push(event.url);
      if (event.date > entry.lastSeen) entry.lastSeen = event.date;
      tests.set(key, entry);
      if (!fileSeen.has(failure.file)) {
        fileSeen.add(failure.file);
        files.set(failure.file, (files.get(failure.file) ?? 0) + 1);
      }
    }
  }
  const byCount = (a, b) =>
    b.count - a.count || b.lastSeen.localeCompare(a.lastSeen);
  return {
    tests: [...tests.values()]
      .map((entry) => ({ ...entry, jobs: [...entry.jobs].sort() }))
      .sort(byCount),
    files: [...files.entries()]
      .map(([file, count]) => ({ file, count }))
      .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file)),
  };
}

/** The report as text for a terminal. */
export function formatReport(ranking, summary, { top = 20 } = {}) {
  const lines = [
    `Flake report for ${summary.repo}, ${summary.since} to ${summary.until} (${summary.workflows.join(", ")})`,
    `${summary.runs} completed runs, ${summary.retriedCommits} commits tried more than once, ${summary.flakedJobs} jobs failed and then passed.`,
    `GitHub API calls: ${summary.apiCalls}${
      summary.budgetHit
        ? ` (stopped at the budget while ${summary.stoppedWhile}, after ${summary.runListsRead} of ${summary.runLists} run lists and ${summary.commitsRead} of ${summary.retriedCommits} retried commits; the report is partial)`
        : ""
    }.`,
    "",
    `Top ${Math.min(top, ranking.tests.length)} flaky tests:`,
  ];
  ranking.tests.slice(0, top).forEach((entry, index) => {
    const project = entry.project ? `[${entry.project}] ` : "";
    lines.push(
      `${String(index + 1).padStart(2)}. ${entry.count}x  ${entry.kind}  ${project}${entry.file}`,
      `      ${entry.name}`,
      `      last seen ${entry.lastSeen.slice(0, 10)} in ${entry.jobs.join("; ")}`,
      ...entry.examples.map((url) => `      ${url}`),
    );
  });
  lines.push("", "Flaked jobs per test file:");
  for (const { file, count } of ranking.files.slice(0, top)) {
    lines.push(`  ${String(count).padStart(3)}  ${file}`);
  }
  return lines.join("\n");
}
