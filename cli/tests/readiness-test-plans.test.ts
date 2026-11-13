/**
 * `mcpjam readiness submission plan` and `run --test-plan-revision`.
 *
 * What these pin: each verb sends the route and body the test plan API
 * documents; `draft --output` writes the plan to a file that `save --file`
 * reads back; `save` takes the revision from the flag or from what `plan show`
 * printed, and never guesses one; a file that is not a plan is refused before
 * any request; and a run names the plan revision only when asked.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Command } from "commander";
import { registerReadinessCommands } from "../src/commands/readiness.js";
import { CliError } from "../src/lib/output.js";
import { captureProcessOutput } from "./support/cli-run.js";

const PROJECT = { id: "project-1", name: "Checkout", organizationId: "org-a", createdAt: 1, updatedAt: 2 };
const ONE = "/api/v1/projects/project-1/directory-submissions/sub-1";
const PLAN = {
  schemaVersion: 1,
  fixtures: [],
  tools: [{ tool: "search_docs", effect: "read", openWorld: false, action: "run", writes: [] }],
  cases: [{ id: "search_docs#valid", tool: "search_docs", kind: "valid", arguments: { query: "pricing" } }],
  budget: { maxCalls: 1, concurrency: 1, callTimeoutMs: 30000 },
  cleanup: [],
};
const SAVED = { submissionId: "sub-1", revision: 3, counts: { tools: 1, cases: 1, fixtures: 0, cleanup: 0 }, savedBy: "user-1", savedAt: 9 };
const CATALOG = { revisionNumber: 7, capturedAt: 40 };

type Reply = { status?: number; body: unknown };
type Captured = { key: string; query: Record<string, string>; body: unknown };

/** The API the commands reach. Each key answers its replies in order. */
function stubFetch(routes: Record<string, Reply[]>): Captured[] {
  const requests: Captured[] = [];
  globalThis.fetch = (async (target: unknown, init?: RequestInit) => {
    const url = new URL(String(target));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    if (key.endsWith("/projects")) return Response.json({ items: [PROJECT] });
    const reply = routes[key]?.shift();
    if (!reply) throw new Error(`unexpected ${key}`);
    requests.push({
      key,
      query: Object.fromEntries(url.searchParams),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json(reply.body, { status: reply.status ?? 200 });
  }) as typeof fetch;
  return requests;
}

function buildProgram(): Command {
  const program = new Command()
    .name("mcpjam")
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerReadinessCommands(program);
  return program;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Runs one command against the stubbed API and returns what it printed. */
async function run(args: string[]) {
  const { stdout } = await captureProcessOutput(() =>
    buildProgram().parseAsync(["readiness", "submission", ...args, "--api-key", "sk_test"], { from: "user" })
  );
  return JSON.parse(stdout) as Record<string, unknown>;
}

const scratch = () => mkdtempSync(join(tmpdir(), "mcpjam-plan-"));

function usage(pattern: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof CliError, String(error));
    assert.equal(error.code, "USAGE_ERROR");
    assert.match(error.message, pattern);
    return true;
  };
}

test("plan show reads the current plan, or the revision named", async () => {
  const view = { ...SAVED, plan: PLAN, issues: [], catalog: CATALOG };
  const requests = stubFetch({ [`GET ${ONE}/test-plan`]: [{ body: view }, { body: view }] });
  const shown = await run(["plan", "show", "sub-1"]);
  await run(["plan", "show", "sub-1", "--revision", "2"]);
  assert.equal(shown.revision, 3);
  assert.deepEqual(
    requests.map((request) => request.query),
    [{}, { revision: "2" }]
  );
});

test("plan draft --output writes the plan to edit, and save --file sends it back", async () => {
  const file = join(scratch(), "plan.json");
  const requests = stubFetch({
    [`GET ${ONE}/test-plan/draft`]: [{ body: { plan: PLAN, issues: [], catalog: CATALOG, currentRevision: 0 } }],
    [`PUT ${ONE}/test-plan`]: [{ body: { ...SAVED, revision: 1, issues: [], catalog: CATALOG } }],
  });
  const drafted = await run(["plan", "draft", "sub-1", "--output", file]);
  assert.equal(drafted.planFile, file);
  assert.equal(drafted.currentRevision, 0);
  assert.ok(!("plan" in drafted));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), PLAN);

  // A bare plan names no revision, so the save asks for one.
  await assert.rejects(run(["plan", "save", "sub-1", "--file", file]), usage(/Pass --expected-revision/));
  const saved = await run(["plan", "save", "sub-1", "--file", file, "--expected-revision", "0"]);
  assert.equal(saved.revision, 1);
  assert.deepEqual(requests.at(-1), { key: `PUT ${ONE}/test-plan`, query: {}, body: { expectedRevision: 0, plan: PLAN } });
});

test("plan save reads the revision from what plan show printed", async () => {
  const file = join(scratch(), "shown.json");
  writeFileSync(file, JSON.stringify({ project: PROJECT, ...SAVED, plan: PLAN, issues: [], catalog: CATALOG }));
  const requests = stubFetch({ [`PUT ${ONE}/test-plan`]: [{ body: { ...SAVED, revision: 4, issues: [], catalog: CATALOG } }] });
  await run(["plan", "save", "sub-1", "--file", file]);
  assert.deepEqual(requests[0]!.body, { expectedRevision: 3, plan: PLAN });
});

test("plan save refuses a file that is not a plan, before any request", async () => {
  const directory = scratch();
  const notJson = join(directory, "notes.txt");
  const misspelled = join(directory, "misspelled.json");
  writeFileSync(notJson, "not json");
  writeFileSync(misspelled, JSON.stringify({ ...PLAN, cases: [{ ...PLAN.cases[0], argument: {} }] }));
  const requests = stubFetch({});
  await assert.rejects(run(["plan", "save", "sub-1", "--file", notJson, "--expected-revision", "1"]), usage(/is not JSON/));
  await assert.rejects(
    run(["plan", "save", "sub-1", "--file", misspelled, "--expected-revision", "1"]),
    usage(/is not a test plan\. cases\.0/)
  );
  assert.equal(requests.length, 0);
});

test("plan results reads one run, one tool, or one status", async () => {
  const tests = { run: { id: "run-1" }, testPlanRevision: 3, source: "ledger", tools: [], counts: {}, inDoubt: [], cleanup: [] };
  const requests = stubFetch({ [`GET ${ONE}/tool-tests`]: [{ body: tests }, { body: tests }] });
  const read = await run(["plan", "results", "sub-1", "--run", "run-1"]);
  await run(["plan", "results", "sub-1", "--status", "ambiguous"]);
  assert.equal(read.testPlanRevision, 3);
  assert.deepEqual(
    requests.map((request) => request.query),
    [{ runId: "run-1" }, {}]
  );
  await assert.rejects(run(["plan", "results", "sub-1", "--status", "fine"]));
});

test("run names a test plan revision only when asked", async () => {
  const receipt = { runId: "run-2", projectId: "project-1", status: "pending", deduped: false };
  const requests = stubFetch({ [`POST ${ONE}/runs`]: [{ status: 202, body: receipt }, { status: 202, body: receipt }] });
  await run(["run", "sub-1", "--test-plan-revision", "3"]);
  await run(["run", "sub-1"]);
  assert.deepEqual(
    requests.map((request) => request.body),
    [{ testPlanRevision: 3 }, {}]
  );
  await assert.rejects(run(["run", "sub-1", "--test-plan-revision", "0"]), usage(/positive integer/));
});
