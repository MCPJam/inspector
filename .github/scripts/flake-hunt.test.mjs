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
    { runId: 1, attempt: 2, createdAt: "2026-11-20T00:00:00Z", jobs: null },
    {
      runId: 1,
      attempt: 1,
      createdAt: "2026-11-20T00:00:00Z",
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
      createdAt: "2026-11-20T00:00:00Z",
      jobs: [job("A", "failure", 1), job("B", "failure", 2), job("C", "cancelled", 3)],
    },
    {
      runId: 2,
      attempt: 1,
      createdAt: "2026-11-20T01:00:00Z",
      jobs: [job("A", "success"), job("B", "failure"), job("C", "success")],
    },
  ]);
  assert.deepEqual(flaked.map(({ job: failed }) => failed.id), [1]);
});

test("findFlakedJobs ignores a failure that no later try passed", () => {
  assert.deepEqual(
    findFlakedJobs([
      { runId: 2, attempt: 1, createdAt: "2026-11-20T01:00:00Z", jobs: null },
      { runId: 3, attempt: 1, createdAt: "2026-11-20T02:00:00Z", jobs: [job("A", "failure")] },
    ]),
    [],
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

// A fake `gh api` over one commit: attempt 1 fails shard 3 and Packaging,
// whose log GitHub no longer has; attempt 2 passes.
function fakeGh(calls) {
  return async ([, path]) => {
    calls.push(path);
    if (path.includes("/workflows/test.yml/runs")) {
      const today = new Date().toISOString().slice(0, 10);
      const runs = path.includes(`created=${today}..`)
        ? [{ id: 7, head_sha: "abc", run_attempt: 2, status: "completed", conclusion: "success", created_at: `${today}T01:00:00Z`, html_url: "run/7" }]
        : [];
      return JSON.stringify({ total_count: runs.length, workflow_runs: runs });
    }
    if (path.includes("/runs/7/attempts/1/jobs")) {
      return JSON.stringify({
        total_count: 1,
        jobs: [
          { id: 70, name: "Inspector Tests 3/6", status: "completed", conclusion: "failure", html_url: "job/70", completed_at: "2026-11-21T01:10:00Z" },
          { id: 71, name: "Packaging", status: "completed", conclusion: "failure", html_url: "job/71", completed_at: "2026-11-21T01:09:00Z" },
        ],
      });
    }
    if (path.endsWith("/jobs/70/logs")) return vitestLog;
    if (path.endsWith("/jobs/71/logs")) throw new Error("gh api ... exited 1: gh: HTTP 404");
    throw new Error(`unexpected path ${path}`);
  };
}

test("hunt ranks a rerun's failures and reads them from the cache the second time", async () => {
  const cache = mkdtempSync(join(tmpdir(), "flake-hunt-test-"));
  try {
    const options = { ...parseArgs(["--days", "1", "--cache", cache]), maxCalls: 50 };
    const calls = [];
    const first = await hunt(options, createGitHub({ maxCalls: 50, run: fakeGh(calls) }));
    assert.equal(first.summary.flakedJobs, 2);
    assert.equal(first.ranking.tests[0].name, "Suite > opens the dialog");
    assert.deepEqual(
      first.ranking.tests.find((entry) => entry.kind === "job"),
      { kind: "job", project: null, file: "Packaging", name: "log unavailable (HTTP 404)", count: 1, jobs: ["test.yml / Packaging"], examples: ["job/71"], lastSeen: "2026-11-21T01:09:00Z" },
    );
    assert.deepEqual(first.ranking.tests[0].examples, ["job/70"]);
    const firstCalls = calls.length;
    await hunt(options, createGitHub({ maxCalls: 50, run: fakeGh(calls) }));
    assert.equal(calls.length, firstCalls, "the second run reads everything from the cache");
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test("hunt stops at the call budget and marks the report partial", async () => {
  const cache = mkdtempSync(join(tmpdir(), "flake-hunt-test-"));
  try {
    const options = { ...parseArgs(["--days", "1", "--cache", cache]), maxCalls: 1 };
    const result = await hunt(options, createGitHub({ maxCalls: 1, run: fakeGh([]) }));
    assert.equal(result.summary.budgetHit, true);
    assert.equal(result.summary.apiCalls, 1);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});
