/**
 * `mcpjam readiness submission evals …`.
 *
 * What these pin: each verb sends the route and body the evals API documents;
 * `link` reads the current revision only when none is given; `unlink` sends
 * `null` for what it clears; and `export` prints the file's exact bytes, or
 * saves them, with what the form would still refuse on stderr.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Command } from "commander";
import { registerReadinessCommands } from "../src/commands/readiness.js";
import { CliError } from "../src/lib/output.js";
import { captureProcessOutput } from "./support/cli-run.js";

const PROJECT = { id: "project-1", name: "Checkout", organizationId: "org-a", createdAt: 1, updatedAt: 2 };
const EVALS = "/api/v1/projects/project-1/directory-submissions/sub-1/evals";
const LINK = { submissionId: "sub-1", revision: 4, suite: { id: "suite-1", name: "Review cases" }, run: null };
const CASES = { successful: [{ prompt: "Where is order 1042?", expectation: "Names its status." }], gracefulFailure: [] };
const FILE = {
  submissionId: "sub-1",
  directory: "openai",
  suite: LINK.suite,
  counts: { successful: 1, gracefulFailure: 0 },
  required: { successful: 5, gracefulFailure: 3 },
  omitted: [{ testCaseId: "case-9", title: "Refund", negative: true, reason: "no_expectation" }],
  filename: "chatgpt-plugin-sub-1-test-cases.json",
  mediaType: "application/json",
  content: `${JSON.stringify(CASES, null, 2)}\n`,
};

type Reply = { status?: number; body: unknown };
type Captured = { key: string; body: unknown };

/** The API the commands reach. Each key answers its replies in order. */
function stubFetch(routes: Record<string, Reply[]>): Captured[] {
  const requests: Captured[] = [];
  globalThis.fetch = (async (target: unknown, init?: RequestInit) => {
    const url = new URL(String(target));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    if (key.endsWith("/projects")) return Response.json({ items: [PROJECT] });
    const reply = routes[key]?.shift();
    if (!reply) throw new Error(`unexpected ${key}`);
    requests.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json(reply.body, { status: reply.status ?? 200 });
  }) as typeof fetch;
  return requests;
}

function buildProgram(): Command {
  const program = new Command()
    .name("mcpjam")
    .option("--quiet")
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
function capture(args: string[]) {
  return captureProcessOutput(() =>
    buildProgram().parseAsync([...args, "--api-key", "sk_test"], { from: "user" })
  );
}

async function run(args: string[]) {
  const { stdout } = await capture(["readiness", "submission", "evals", ...args]);
  return JSON.parse(stdout) as Record<string, unknown>;
}

test("show reads the link and its results", async () => {
  const requests = stubFetch({ [`GET ${EVALS}`]: [{ body: { ...LINK, results: [], truncated: false } }] });
  const shown = await run(["show", "sub-1"]);
  assert.equal((shown.suite as { id: string }).id, "suite-1");
  assert.deepEqual(requests.map((request) => request.key), [`GET ${EVALS}`]);
});

test("link sends the suite and run at the revision given, or reads it first", async () => {
  const requests = stubFetch({
    [`PATCH ${EVALS}`]: [{ body: LINK }, { body: LINK }],
    [`GET ${EVALS}`]: [{ body: { ...LINK, revision: 6, results: [], truncated: false } }],
  });
  await run(["link", "sub-1", "--suite", "suite-1", "--run", "run-1", "--expected-revision", "4", "--idempotency-key", "k1"]);
  await run(["link", "sub-1", "--run", "run-2"]);
  assert.deepEqual(requests.map((request) => request.key), [`PATCH ${EVALS}`, `GET ${EVALS}`, `PATCH ${EVALS}`]);
  assert.deepEqual(requests[0]!.body, { expectedRevision: 4, suiteId: "suite-1", runId: "run-1", idempotencyKey: "k1" });
  assert.deepEqual({ ...(requests[2]!.body as object), idempotencyKey: "derived" }, {
    expectedRevision: 6,
    runId: "run-2",
    idempotencyKey: "derived",
  });
});

test("link without a suite or a run is refused before any request", async () => {
  const requests = stubFetch({});
  await assert.rejects(run(["link", "sub-1"]), (error: unknown) => {
    assert.ok(error instanceof CliError, String(error));
    assert.equal(error.code, "USAGE_ERROR");
    assert.match(error.message, /Pass --suite, --run or both/);
    return true;
  });
  assert.equal(requests.length, 0);
});

test("unlink clears the suite, or with --run-only only the run", async () => {
  const requests = stubFetch({ [`PATCH ${EVALS}`]: [{ body: LINK }, { body: LINK }] });
  await run(["unlink", "sub-1", "--expected-revision", "4", "--idempotency-key", "k1"]);
  await run(["unlink", "sub-1", "--run-only", "--expected-revision", "5", "--idempotency-key", "k2"]);
  assert.deepEqual(
    requests.map((request) => request.body),
    [
      { expectedRevision: 4, suiteId: null, idempotencyKey: "k1" },
      { expectedRevision: 5, runId: null, idempotencyKey: "k2" },
    ]
  );
});

test("import names the plugin version only when given", async () => {
  const imported = { suiteId: "suite-1", pluginVersionId: "ver-1", created: 2, existing: 0, cases: [], skipped: [] };
  const requests = stubFetch({ [`POST ${EVALS}/import`]: [{ body: imported }, { body: imported }] });
  const result = await run(["import", "sub-1"]);
  await run(["import", "sub-1", "--plugin-version", "ver-1"]);
  assert.equal(result.created, 2);
  assert.deepEqual(requests.map((request) => request.body), [{}, { pluginVersionId: "ver-1" }]);
});

test("export prints the file's exact bytes, and what the form would refuse on stderr", async () => {
  stubFetch({ [`GET ${EVALS}/export`]: [{ body: FILE }] });
  const { stdout, stderr } = await capture(["readiness", "submission", "evals", "export", "sub-1"]);
  assert.equal(stdout, FILE.content);
  assert.match(stderr, /Left out "Refund": it has no expectation\./);
  assert.match(stderr, /asks for 5 successful and 3 graceful-failure cases; this file has 1 and 0\./);
});

test("export --out saves the bytes to a file or a folder, and --quiet drops the notes", async () => {
  const folder = mkdtempSync(join(tmpdir(), "mcpjam-evals-"));
  const file = join(folder, "cases.json");
  stubFetch({ [`GET ${EVALS}/export`]: [{ body: FILE }, { body: FILE }] });
  const saved = await capture(["readiness", "submission", "evals", "export", "sub-1", "--out", file]);
  const printed = JSON.parse(saved.stdout) as Record<string, unknown>;
  assert.equal(readFileSync(file, "utf8"), FILE.content);
  assert.deepEqual({ path: printed.path, bytes: printed.bytes }, { path: file, bytes: Buffer.byteLength(FILE.content) });
  assert.ok(!("content" in printed));

  const quiet = await capture(["--quiet", "readiness", "submission", "evals", "export", "sub-1", "--out", folder]);
  assert.equal(readFileSync(join(folder, FILE.filename), "utf8"), FILE.content);
  assert.equal(quiet.stderr, "");
});
