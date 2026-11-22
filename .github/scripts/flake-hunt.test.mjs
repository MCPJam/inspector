import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGitHub, hunt, parseArgs, windowDays } from "./flake-hunt.mjs";
import { cleanLine, findFlakedJobs, firstError, formatReport, parseFailures, rankFlakes } from "./flake-hunt-report.mjs";

const ts = "2026-11-21T18:25:24.6503458Z ";
const red = (text) => `\x1b[31m${text}\x1b[39m`;
const label = (text) => `\x1b[30m\x1b[46m ${text} \x1b[49m\x1b[39m`;

const vitestLog = [
  `${ts}${label("client")} client/src/a.test.tsx (3 tests | 1 failed) 812ms`,
  `${ts}   ${red("×")} Suite > opens the dialog 801ms`,
  `${ts}${red("⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯")}`,
  `${ts}`,
  `${ts} ${red("FAIL")} ${label("client")} client/src/a.test.tsx${"\x1b[2m"} > ${"\x1b[22m"}Suite > opens the dialog`,
  `${ts}TestingLibraryElementError: Unable to find role "dialog"`,
  `${ts} ${red("FAIL")}  |server| server/b.test.ts > handles > a > nested name`,
  `${ts} ${red("FAIL")} ${label("client")} src/d.test.tsx > joins the project directory`,
  `${ts} ${red("FAIL")} ${label("client")} client/src/broken.test.tsx [ client/src/broken.test.tsx ]`,
  `${ts} ${red("FAIL")} ${label("client")} client/src/a.test.tsx > Suite > opens the dialog`,
  `${ts}stderr | client/src/c.test.tsx > the rows still FAIL an iteration`,
  `${ts}##[error]Process completed with exit code 1.`,
].join("\n");

const unhandledLog = [
  `${ts} ✓  src  __tests__/electron-auth-proxy.test.ts (1 test) 68ms`,
  `${ts}${red("⎯⎯⎯⎯⎯⎯")}\x1b[1m\x1b[41m Unhandled Errors \x1b[49m\x1b[22m${red("⎯⎯⎯⎯⎯⎯")}`,
  `${ts}Vitest caught 2 unhandled errors during the test run.`,
  `${ts}${red("⎯⎯⎯⎯⎯ Uncaught Exception ⎯⎯⎯⎯⎯")}`,
  `${ts}ReferenceError: window is not defined`,
  `${ts} ❯ Timeout._onTimeout client/src/components/canvas-kit/CanvasShell.tsx:146:21`,
  `${ts}This error originated in "client/src/x/ServerCanvasPage.test.tsx" test file. It doesn't mean the error was thrown inside the file itself, but while it was running.`,
  `${ts}${red("⎯⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯")}`,
  `${ts}Error: request 123456 timed out`,
  `${ts}This error originated in "client/src/y.test.tsx" test file.`,
  `${ts}The latest test that might've caused the error is "loads > retries". It might mean one of the following:`,
  `${ts}${red("⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯")}`,
  `${ts} Test Files  627 passed | 3 skipped (630)`,
  `${ts}     Errors  2 errors`,
].join("\n");

const playwrightLog = [
  `${ts}  1) [chromium] › e2e/smoke.spec.ts:12:5 › opens the app ──────`,
  `${ts}  2 failed`,
  `${ts}    [chromium] › e2e/smoke.spec.ts:12:5 › opens the app`,
  `${ts}    [chromium] › e2e/oauth.spec.ts:40:3 › OAuth › finishes the flow`,
  `${ts}  1 flaky`,
  `${ts}    [chromium] › e2e/other.spec.ts:1:1 › retried and passed`,
  `${ts}  30 passed (1.2m)`,
].join("\n");

test("cleanLine strips colour codes and the runner timestamp", () => {
  assert.equal(cleanLine(`${ts}${red("FAIL")} x\r`), "FAIL x");
});

test("parseFailures reads each Vitest FAIL line once, with or without a project", () => {
  assert.deepEqual(parseFailures(vitestLog), [
    { kind: "test", project: "client", file: "client/src/a.test.tsx", name: "Suite > opens the dialog" },
    { kind: "test", project: "server", file: "server/b.test.ts", name: "handles > a > nested name" },
    { kind: "test", project: "client", file: "client/src/d.test.tsx", name: "joins the project directory" },
    { kind: "test", project: "client", file: "client/src/broken.test.tsx", name: "(file failed to load)" },
  ]);
});

test("parseFailures attributes unhandled errors to the file they came from", () => {
  assert.deepEqual(parseFailures(unhandledLog), [
    {
      kind: "unhandled",
      project: null,
      file: "client/src/x/ServerCanvasPage.test.tsx",
      name: "ReferenceError: window is not defined",
    },
    {
      kind: "unhandled",
      project: null,
      file: "client/src/y.test.tsx",
      name: "Error: request N timed out (latest test: loads > retries)",
    },
  ]);
});

test("parseFailures reads Playwright failures but not its flaky list", () => {
  assert.deepEqual(parseFailures(playwrightLog), [
    { kind: "playwright", project: "chromium", file: "e2e/smoke.spec.ts", name: "opens the app" },
    { kind: "playwright", project: "chromium", file: "e2e/oauth.spec.ts", name: "OAuth › finishes the flow" },
  ]);
});

test("firstError returns the first ##[error] message", () => {
  assert.equal(firstError(vitestLog), "Process completed with exit code 1.");
  assert.equal(firstError("nothing here"), null);
});

const job = (name, conclusion, id = Math.random()) => ({ id, name, conclusion, url: `job/${id}` });

test("findFlakedJobs pairs a failed job with a later attempt that passed it", () => {
  const flaked = findFlakedJobs([
    { runId: 1, attempt: 2, startedAt: "2026-11-20T00:30:00Z", jobs: [job("Inspector Tests 3/6", "success"), job("Run Tests", "success")] },
    {
      runId: 1,
      attempt: 1,
      startedAt: "2026-11-20T00:00:00Z",
      jobs: [job("Inspector Tests 3/6", "failure", 11), job("Run Tests", "success", 12)],
    },
  ]);
  assert.deepEqual(
    flaked.map(({ job: failed, passedOn }) => [failed.id, passedOn]),
    [[11, { runId: 1, attempt: 2 }]],
  );
});

test("findFlakedJobs matches by job name across runs on the same SHA", () => {
  const flaked = findFlakedJobs([
    {
      runId: 1,
      attempt: 1,
      startedAt: "2026-11-20T00:00:00Z",
      jobs: [job("A", "failure", 1), job("B", "failure", 2), job("C", "cancelled", 3)],
    },
    {
      runId: 2,
      attempt: 1,
      startedAt: "2026-11-20T01:00:00Z",
      jobs: [job("A", "success"), job("B", "failure"), job("C", "success")],
    },
  ]);
  assert.deepEqual(flaked.map(({ job: failed }) => failed.id), [1]);
});

test("findFlakedJobs ignores a failure that no later try passed", () => {
  assert.deepEqual(
    findFlakedJobs([
      { runId: 2, attempt: 1, startedAt: "2026-11-20T01:00:00Z", jobs: [job("A", "success")] },
      { runId: 3, attempt: 1, startedAt: "2026-11-20T02:00:00Z", jobs: [job("A", "failure")] },
    ]),
    [],
  );
});

test("findFlakedJobs does not count a later success that skipped or dropped the job", () => {
  assert.deepEqual(
    findFlakedJobs([
      { runId: 1, attempt: 1, startedAt: "2026-11-20T00:00:00Z", jobs: [job("A", "failure"), job("B", "failure")] },
      { runId: 1, attempt: 2, startedAt: "2026-11-20T01:00:00Z", jobs: [job("A", "skipped"), job("C", "success")] },
    ]),
    [],
  );
});

test("findFlakedJobs orders tries by when the attempt started, not when its run was created", () => {
  // Run 1 is older, but its second attempt started after run 2 failed.
  const flaked = findFlakedJobs([
    { runId: 1, attempt: 1, startedAt: "2026-11-20T00:00:00Z", jobs: [job("A", "failure", 1)] },
    { runId: 2, attempt: 1, startedAt: "2026-11-20T01:00:00Z", jobs: [job("A", "failure", 2)] },
    { runId: 1, attempt: 2, startedAt: "2026-11-20T02:00:00Z", jobs: [job("A", "success")] },
  ]);
  assert.deepEqual(
    flaked.map(({ job: failed, passedOn }) => [failed.id, passedOn]),
    [
      [1, { runId: 1, attempt: 2 }],
      [2, { runId: 1, attempt: 2 }],
    ],
  );
});

test("rankFlakes counts flaked jobs per test and per file, newest first on ties", () => {
  const a = { kind: "test", project: "client", file: "a.test.tsx", name: "one" };
  const b = { kind: "test", project: "client", file: "a.test.tsx", name: "two" };
  const c = { kind: "test", project: "client", file: "c.test.tsx", name: "three" };
  const ranking = rankFlakes(
    [
      { url: "u1", jobName: "Inspector Tests 1/6", workflow: "test.yml", date: "2026-11-10", failures: [a, b] },
      { url: "u2", jobName: "Inspector Tests 2/6", workflow: "test.yml", date: "2026-11-12", failures: [a] },
      { url: "u3", jobName: "Inspector Tests 2/6", workflow: "test.yml", date: "2026-11-15", failures: [c] },
      { url: "u4", jobName: "Packaging", workflow: "test.yml", date: "2026-11-11", failures: [], error: "npm ci failed" },
    ],
    { examples: 1 },
  );
  assert.deepEqual(
    ranking.tests.map((entry) => [entry.name, entry.count, entry.examples, entry.lastSeen]),
    [
      ["one", 2, ["u1"], "2026-11-12"],
      ["three", 1, ["u3"], "2026-11-15"],
      ["npm ci failed", 1, ["u4"], "2026-11-11"],
      ["two", 1, ["u1"], "2026-11-10"],
    ],
  );
  assert.deepEqual(ranking.tests[0].jobs, ["test.yml / Inspector Tests 1/6", "test.yml / Inspector Tests 2/6"]);
  assert.deepEqual(ranking.files, [
    { file: "a.test.tsx", count: 2 },
    { file: "c.test.tsx", count: 1 },
    { file: "Packaging", count: 1 },
  ]);
  const text = formatReport(ranking, {
    repo: "o/r",
    since: "2026-11-07",
    until: "2026-11-21",
    workflows: ["test.yml"],
    runs: 10,
    retriedCommits: 2,
    flakedJobs: 4,
    apiCalls: 7,
    budgetHit: false,
  });
  assert.match(text, / 1\. 2x {2}test {2}\[client\] a\.test\.tsx\n {6}one\n/);
});

test("parseArgs defaults to test.yml over 14 days and rejects unknown flags", () => {
  const options = parseArgs([]);
  assert.equal(options.days, 14);
  assert.deepEqual(options.workflows, ["test.yml"]);
  assert.deepEqual(parseArgs(["--workflow", "lint.yml", "--days", "3"]).workflows, ["lint.yml"]);
  assert.throws(() => parseArgs(["--days", "0"]), /positive whole number/);
  assert.throws(() => parseArgs(["--retry"]), /Unknown option/);
});

test("windowDays lists each UTC day of the window, oldest first", () => {
  assert.deepEqual(windowDays(2, Date.parse("2026-11-21T05:00:00Z")), ["2026-11-19", "2026-11-20", "2026-11-21"]);
});

const today = new Date().toISOString().slice(0, 10);
const ghRun = (id, fields) => ({ id, head_sha: "abc", event: "push", run_attempt: 1, status: "completed", conclusion: "success", created_at: `${today}T01:00:00Z`, html_url: `run/${id}`, ...fields });
const ghJob = (id, name, conclusion, startedAt) => ({ id, name, status: "completed", conclusion, html_url: `job/${id}`, started_at: startedAt, completed_at: startedAt.replace(":00:", ":10:") });

// A fake `gh api` over today's runs. By default one commit: attempt 1 fails
// shard 3 and Packaging, whose log GitHub no longer has; attempt 2 passes.
function fakeGh(
  calls,
  {
    runs = [ghRun(7, { run_attempt: 2 })],
    jobs = {
      "7/1": [ghJob(70, "Inspector Tests 3/6", "failure", "2026-11-21T01:00:00Z"), ghJob(71, "Packaging", "failure", "2026-11-21T01:00:00Z")],
      "7/2": [ghJob(72, "Inspector Tests 3/6", "success", "2026-11-21T02:00:00Z"), ghJob(73, "Packaging", "success", "2026-11-21T02:00:00Z")],
    },
  } = {},
) {
  return async ([, path]) => {
    calls.push(path);
    if (path.includes("/workflows/test.yml/runs")) {
      const listed = path.includes(`created=${today}..`) ? runs : [];
      return JSON.stringify({ total_count: listed.length, workflow_runs: listed });
    }
    const attempt = /\/runs\/(\d+)\/attempts\/(\d+)\/jobs/.exec(path);
    if (attempt) {
      const list = jobs[`${attempt[1]}/${attempt[2]}`];
      return JSON.stringify({ total_count: list.length, jobs: list });
    }
    if (path.endsWith("/jobs/70/logs")) return vitestLog;
    if (path.endsWith("/jobs/71/logs")) throw new Error("gh api ... exited 1: gh: HTTP 404");
    throw new Error(`unexpected path ${path}`);
  };
}

async function withCache(body) {
  const cache = mkdtempSync(join(tmpdir(), "flake-hunt-test-"));
  try {
    await body(cache);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

const huntWith = (cache, maxCalls, run, flags = []) =>
  hunt({ ...parseArgs(["--days", "1", "--cache", cache, ...flags]), maxCalls }, createGitHub({ maxCalls, run }));

test("hunt ranks a rerun's failures and reads them from the cache the second time", () =>
  withCache(async (cache) => {
    const calls = [];
    const first = await huntWith(cache, 50, fakeGh(calls));
    assert.equal(first.summary.flakedJobs, 2);
    assert.equal(first.ranking.tests[0].name, "Suite > opens the dialog");
    assert.deepEqual(
      first.ranking.tests.find((entry) => entry.kind === "job"),
      { kind: "job", project: null, file: "Packaging", name: "log unavailable (HTTP 404)", count: 1, jobs: ["test.yml / Packaging"], examples: ["job/71"], lastSeen: "2026-11-21T01:10:00Z" },
    );
    assert.deepEqual(first.ranking.tests[0].examples, ["job/70"]);
    const firstCalls = calls.length;
    await huntWith(cache, 50, fakeGh(calls));
    assert.equal(calls.length, firstCalls, "the second run reads everything from the cache");
  }));

test("hunt does not compare runs of different events on the same commit", () =>
  withCache(async (cache) => {
    const result = await huntWith(
      cache,
      50,
      fakeGh([], {
        runs: [ghRun(8, { event: "push", conclusion: "failure" }), ghRun(9, { event: "pull_request", created_at: `${today}T02:00:00Z` })],
        jobs: {
          "8/1": [ghJob(80, "Inspector Tests 3/6", "failure", "2026-11-21T01:00:00Z")],
          "9/1": [ghJob(90, "Inspector Tests 3/6", "success", "2026-11-21T02:00:00Z")],
        },
      }),
    );
    assert.equal(result.summary.retriedCommits, 0);
    assert.equal(result.summary.flakedJobs, 0);
  }));

test("hunt keeps each repository's run lists apart in a shared cache", () =>
  withCache(async (cache) => {
    await huntWith(cache, 50, fakeGh([]), ["--repo", "a/one"]);
    const calls = [];
    const second = await huntWith(cache, 50, fakeGh(calls), ["--repo", "b/two"]);
    assert.ok(calls.length > 0 && calls.every((path) => path.startsWith("repos/b/two/")));
    assert.equal(second.summary.flakedJobs, 2);
  }));

test("hunt reports how far it got when it stops at the call budget", () =>
  withCache(async (cache) => {
    const result = await huntWith(cache, 1, fakeGh([]));
    assert.equal(result.summary.apiCalls, 1);
    assert.deepEqual(
      [result.summary.budgetHit, result.summary.stoppedWhile, result.summary.runListsRead, result.summary.runLists],
      [true, "listing runs", 1, 2],
    );
    assert.match(
      formatReport(result.ranking, result.summary),
      /stopped at the budget while listing runs, after 1 of 2 run lists and 0 of 0 retried commits; the report is partial/,
    );
  }));

test("hunt still ranks the flaked jobs it found when the budget runs out before their logs", () =>
  withCache(async (cache) => {
    const attempts = await huntWith(cache, 3, fakeGh([]));
    assert.deepEqual(
      [attempts.summary.stoppedWhile, attempts.summary.commitsRead, attempts.summary.retriedCommits],
      ["reading attempts", 0, 1],
    );
    // The run lists and attempt 1 are cached now; one call reads attempt 2.
    const logs = await huntWith(cache, 1, fakeGh([]));
    assert.equal(logs.summary.stoppedWhile, "reading logs");
    assert.equal(logs.summary.flakedJobs, 2);
    assert.deepEqual(
      logs.ranking.tests.map((entry) => [entry.file, entry.name]),
      [
        ["Inspector Tests 3/6", "log not read (call budget spent)"],
        ["Packaging", "log not read (call budget spent)"],
      ],
    );
  }));
