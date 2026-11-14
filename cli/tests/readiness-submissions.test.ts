/**
 * `mcpjam readiness flows` and `mcpjam readiness submission`.
 *
 * What these pin: each verb sends the route and body the submissions API
 * documents; `--answer` values are read as JSON when they parse and as text
 * otherwise, and a bad one is refused before any request; a conflict is
 * retried only with `--retry-on-conflict`; and `run --wait` exits with the
 * readiness codes, never 1 for a run that graded nothing.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Command } from "commander";
import { registerReadinessCommands } from "../src/commands/readiness.js";
import { CliError } from "../src/lib/output.js";
import { captureProcessOutput } from "./support/cli-run.js";

const PROJECT = {
  id: "project-1",
  name: "Checkout",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 2,
};

const SERVER = {
  id: "server-1",
  projectId: PROJECT.id,
  name: "markets",
  enabled: true,
  transportType: "http",
  url: "https://mcp.example.com/mcp",
  createdAt: 1,
  updatedAt: 2,
};

const VIEW = {
  id: "sub-1",
  projectId: PROJECT.id,
  serverId: SERVER.id,
  directory: "claude",
  flowId: "claude-connector",
  flowVersion: "2026-11-13",
  answers: [],
  revision: 4,
  createdBy: "user-1",
  createdAt: 1,
  updatedAt: 2,
  fieldIssues: [],
  steps: [],
  resultsRunId: null,
  submissionUrl: "https://claude.ai/settings/connectors/submit",
};

const FLOW = {
  id: "claude-connector",
  steps: [
    { id: "connection", title: "Connection", fields: [] },
    { id: "listing", title: "Listing", fields: [] },
  ],
  placements: [],
};

const BASE = "/api/v1/projects/project-1/directory-submissions";

/** The projects the API lists. Automatic selection picks the newest. */
let projects: unknown[] = [PROJECT];

type Reply = { status?: number; body: unknown };
type Captured = { key: string; query: Record<string, string>; body: unknown };

/** The API the commands reach. Each key answers its replies in order. */
function stubFetch(routes: Record<string, Reply[]>): Captured[] {
  const requests: Captured[] = [];
  globalThis.fetch = (async (target: unknown, init?: RequestInit) => {
    const url = new URL(String(target));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    if (key.endsWith("/projects")) return Response.json({ items: projects });
    if (key.endsWith("/servers")) return Response.json({ items: [SERVER] });
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
  projects = [PROJECT];
  delete process.env.MCPJAM_PROJECT;
  // `run --wait` reports its verdict through the process exit code.
  process.exitCode = 0;
});

/** Runs one command against the stubbed API and returns what it printed. */
async function run(args: string[]) {
  const { stdout, stderr } = await captureProcessOutput(() =>
    buildProgram().parseAsync(
      ["readiness", ...args, "--api-key", "sk_test"],
      { from: "user" }
    )
  );
  return { printed: JSON.parse(stdout) as Record<string, unknown>, stderr };
}

function rejectsWith(code: string, pattern: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof CliError, String(error));
    assert.equal(error.code, code);
    assert.match(error.message, pattern);
    return true;
  };
}

test("flows lists the flows, and shows one step of a flow", async () => {
  const requests = stubFetch({
    "GET /api/v1/directory-flows": [{ body: { items: [{ id: FLOW.id }] } }],
    "GET /api/v1/directory-flows/claude-connector": [{ body: FLOW }],
  });
  const listed = await run(["flows"]);
  const shown = await run(["flows", "claude-connector", "--step", "listing"]);

  assert.deepEqual(listed.printed, { flows: [{ id: FLOW.id }] });
  assert.deepEqual(
    (shown.printed.steps as Array<{ id: string }>).map((step) => step.id),
    ["listing"]
  );
  assert.equal(requests.length, 2);
  await assert.rejects(
    run(["flows", "--step", "listing"]),
    rejectsWith("USAGE_ERROR", /--step needs a flow/)
  );
});

test("create, list, get and delete send the documented calls", async () => {
  const requests = stubFetch({
    [`POST ${BASE}`]: [{ status: 201, body: VIEW }],
    [`GET ${BASE}`]: [{ body: { items: [] } }],
    [`GET ${BASE}/sub-1`]: [{ body: VIEW }],
    [`DELETE ${BASE}/sub-1`]: [{ body: { id: "sub-1", deleted: true } }],
  });
  const created = await run([
    "submission",
    "create",
    "--flow",
    "claude-connector",
    "--server",
    "markets",
    "--title",
    "First draft",
  ]);
  await run(["submission", "list", "--server", "markets", "--limit", "5"]);
  await run(["submission", "get", "sub-1"]);
  const deleted = await run(["submission", "delete", "sub-1"]);

  assert.deepEqual(
    requests.map((request) => request.key),
    [`POST ${BASE}`, `GET ${BASE}`, `GET ${BASE}/sub-1`, `DELETE ${BASE}/sub-1`]
  );
  assert.deepEqual(requests[0]!.body, {
    flowId: "claude-connector",
    serverId: "server-1",
    title: "First draft",
  });
  assert.deepEqual(requests[1]!.query, { serverId: "server-1", limit: "5" });
  assert.equal((created.printed.submission as { id: string }).id, "sub-1");
  assert.equal(deleted.printed.deleted, true);
});

test("set reads JSON values when they parse, text otherwise, and unsets", async () => {
  const requests = stubFetch({ [`PATCH ${BASE}/sub-1`]: [{ body: VIEW }] });
  await run([
    "submission",
    "set",
    "sub-1",
    "--answer",
    "listing.name=Acme Markets",
    "--answer",
    'listing.categories=["Finance","Data"]',
    "--answer",
    "connection.differentUrls=true",
    "--answer",
    "listing.oneLiner=Prices = quotes, live",
    "--unset",
    "listing.slug",
    "--confirm",
    "useCases.access",
    "--expected-revision",
    "3",
  ]);
  const body = requests[0]!.body as Record<string, unknown>;
  assert.deepEqual(body.answers, {
    "listing.name": "Acme Markets",
    "listing.categories": ["Finance", "Data"],
    "connection.differentUrls": true,
    "listing.oneLiner": "Prices = quotes, live",
    "listing.slug": null,
  });
  assert.deepEqual(body.confirm, ["useCases.access"]);
  assert.equal(body.expectedRevision, 3);
  assert.match(String(body.idempotencyKey), /^derived:/);
});

test("set reads the current revision when none is given", async () => {
  const requests = stubFetch({
    [`GET ${BASE}/sub-1`]: [{ body: VIEW }],
    [`PATCH ${BASE}/sub-1`]: [{ body: { ...VIEW, revision: 5 } }],
  });
  await run(["submission", "set", "sub-1", "--title", "Second draft"]);
  assert.deepEqual(
    requests.map((request) => request.key),
    [`GET ${BASE}/sub-1`, `PATCH ${BASE}/sub-1`]
  );
  assert.equal((requests[1]!.body as { expectedRevision: number }).expectedRevision, 4);
  assert.equal((requests[1]!.body as { title: string }).title, "Second draft");
});

test("set refuses a malformed or repeated answer before any request", async () => {
  const requests = stubFetch({});
  const set = (...args: string[]) => run(["submission", "set", "sub-1", ...args]);
  await assert.rejects(
    set("--answer", "listing.name"),
    rejectsWith("USAGE_ERROR", /key=value/)
  );
  await assert.rejects(
    set("--answer", "listing.name=A", "--unset", "listing.name"),
    rejectsWith("USAGE_ERROR", /given twice/)
  );
  await assert.rejects(
    set("--answer", 'listing.name={"a":1}', "--expected-revision", "2"),
    rejectsWith("USAGE_ERROR", /answers\.listing\.name/)
  );
  await assert.rejects(set(), rejectsWith("USAGE_ERROR", /Nothing to save/));
  assert.deepEqual(requests, []);
});

const CONFLICT: Reply = {
  status: 409,
  body: {
    code: "CONFLICT",
    message:
      "This submission changed since you read it. Read it again and reapply your change.",
    details: { currentRevision: 7, conflictingKeys: ["listing.name"] },
  },
};

test("set retries a conflict once only with --retry-on-conflict", async () => {
  const change = ["--answer", "listing.name=Acme", "--expected-revision", "4"];
  stubFetch({ [`PATCH ${BASE}/sub-1`]: [CONFLICT] });
  await assert.rejects(
    run(["submission", "set", "sub-1", ...change]),
    rejectsWith("CONFLICT", /changed since you read it/)
  );

  const requests = stubFetch({
    [`PATCH ${BASE}/sub-1`]: [CONFLICT, { body: { ...VIEW, revision: 8 } }],
  });
  const saved = await run([
    "submission",
    "set",
    "sub-1",
    ...change,
    "--retry-on-conflict",
  ]);
  assert.deepEqual(
    requests.map((request) => (request.body as { expectedRevision: number }).expectedRevision),
    [4, 7]
  );
  assert.equal((saved.printed.submission as { revision: number }).revision, 8);
});

const RECEIPT = {
  runId: "run-1",
  projectId: PROJECT.id,
  serverId: SERVER.id,
  readinessKind: "claude",
  status: "pending",
  deduped: false,
  includeLlmObservations: false,
};

function runRow(status: string, overallStatus: string | null) {
  return { id: "run-1", status, overallStatus, lanes: [], stages: [] };
}

test("run without --wait prints the receipt and polls nothing", async () => {
  const requests = stubFetch({
    [`POST ${BASE}/sub-1/runs`]: [{ status: 202, body: RECEIPT }],
  });
  const started = await run(["submission", "run", "sub-1", "--ai-observations"]);
  assert.deepEqual(requests[0]!.body, { includeLlmObservations: true });
  assert.deepEqual(started.printed.run, RECEIPT);
  assert.equal(requests.length, 1);
  assert.equal(process.exitCode, 0);
});

test("run --wait exits 1 for a completed run that is not ready", async () => {
  stubFetch({
    [`POST ${BASE}/sub-1/runs`]: [{ status: 202, body: RECEIPT }],
    "GET /api/v1/projects/project-1/readiness-runs/run-1": [
      { body: runRow("completed", "not-ready") },
    ],
  });
  const waited = await run(["submission", "run", "sub-1", "--wait"]);
  assert.equal((waited.printed.run as { status: string }).status, "completed");
  assert.equal(process.exitCode, 1);
});

test("run --wait exits 3 for a run that failed, never 1", async () => {
  stubFetch({
    [`POST ${BASE}/sub-1/runs`]: [{ status: 202, body: RECEIPT }],
    "GET /api/v1/projects/project-1/readiness-runs/run-1": [
      { body: runRow("failed", null) },
    ],
  });
  await run(["submission", "run", "sub-1", "--wait"]);
  assert.equal(process.exitCode, 3);
});

const RUN_PATH = "/api/v1/projects/project-1/readiness-runs/run-1";
const REQUEUED = { ...runRow("pending", null), resumable: true, attemptCount: 2 };

test("run --wait resumes a re-queued run once, then waits for its verdict", async () => {
  const requests = stubFetch({
    [`POST ${BASE}/sub-1/runs`]: [{ status: 202, body: RECEIPT }],
    [`GET ${RUN_PATH}`]: [{ body: REQUEUED }, { body: runRow("completed", "ready") }],
    [`POST ${RUN_PATH}/resume`]: [{ status: 202, body: { ...RECEIPT, status: "running" } }],
  });
  const waited = await run(["submission", "run", "sub-1", "--wait"]);
  const resumes = requests.filter((r) => r.key === `POST ${RUN_PATH}/resume`);
  assert.equal(resumes.length, 1);
  assert.equal(resumes[0]!.body, undefined);
  assert.match(waited.stderr, /stopped on the server and was resumed/);
  assert.equal((waited.printed.run as { status: string }).status, "completed");
  assert.equal(process.exitCode, 0);
});

test("run --wait goes on waiting when the resume is refused", async () => {
  stubFetch({
    [`POST ${BASE}/sub-1/runs`]: [{ status: 202, body: RECEIPT }],
    [`GET ${RUN_PATH}`]: [{ body: REQUEUED }, { body: runRow("failed", null) }],
    [`POST ${RUN_PATH}/resume`]: [
      {
        status: 403,
        body: {
          code: "FORBIDDEN",
          message: "No readiness run you can resume was found. Start a new run instead.",
        },
      },
    ],
  });
  const waited = await run(["submission", "run", "sub-1", "--wait"]);
  assert.match(waited.stderr, /could not be resumed: No readiness run you can resume/);
  // The run graded nothing, so the wait ends incomplete, never not ready.
  assert.equal(process.exitCode, 3);
});

test("run --wait exits 3 when the run could not be started", async () => {
  stubFetch({
    [`POST ${BASE}/sub-1/runs`]: [
      {
        status: 403,
        body: {
          code: "FORBIDDEN",
          message: "Directory readiness is not available for your organization.",
          details: { code: "FEATURE_UNAVAILABLE", feature: "directory-readiness" },
        },
      },
    ],
  });
  await assert.rejects(
    run(["submission", "run", "sub-1", "--wait"]),
    (error: unknown) => error instanceof CliError && error.exitCode === 3
  );
});

test("results reads one run's results by step", async () => {
  const requests = stubFetch({
    [`GET ${BASE}/sub-1/results`]: [
      {
        body: {
          run: null,
          steps: [],
          counts: { toFix: 0, blockers: 0, likelyFlags: 0, notChecked: 0, passed: 0 },
        },
      },
    ],
  });
  const results = await run(["submission", "results", "sub-1", "--run", "run-1", "--json"]);
  assert.deepEqual(requests[0]!.query, { runId: "run-1" });
  assert.equal(results.printed.submissionId, "sub-1");
});

test("every project-scoped verb takes MCPJAM_PROJECT when --project is omitted", async () => {
  // Older than project-1, so automatic selection alone would never reach it.
  const other = { ...PROJECT, id: "project-2", name: "Linked", updatedAt: 1 };
  projects = [PROJECT, other];
  process.env.MCPJAM_PROJECT = "project-2";
  const base = "/api/v1/projects/project-2/directory-submissions";
  const view = { ...VIEW, projectId: other.id };
  const requests = stubFetch({
    [`POST ${base}`]: [{ status: 201, body: view }],
    [`GET ${base}`]: [{ body: { items: [] } }],
    [`GET ${base}/sub-1`]: [{ body: view }, { body: view }],
    [`PATCH ${base}/sub-1`]: [{ body: { ...view, revision: 5 } }],
    [`DELETE ${base}/sub-1`]: [{ body: { id: "sub-1", deleted: true } }],
    [`GET ${base}/sub-1/results`]: [
      {
        body: {
          run: null,
          steps: [],
          counts: { toFix: 0, blockers: 0, likelyFlags: 0, notChecked: 0, passed: 0 },
        },
      },
    ],
    [`POST ${base}/sub-1/runs`]: [{ status: 202, body: { ...RECEIPT, projectId: other.id } }],
  });

  await run(["submission", "create", "--flow", "claude-connector", "--server", "markets"]);
  await run(["submission", "list"]);
  await run(["submission", "get", "sub-1"]);
  await run(["submission", "set", "sub-1", "--title", "Second draft"]);
  await run(["submission", "results", "sub-1"]);
  await run(["submission", "run", "sub-1"]);
  await run(["submission", "delete", "sub-1"]);

  assert.deepEqual(
    requests.map((request) => request.key),
    [
      `POST ${base}`,
      `GET ${base}`,
      `GET ${base}/sub-1`,
      `GET ${base}/sub-1`,
      `PATCH ${base}/sub-1`,
      `GET ${base}/sub-1/results`,
      `POST ${base}/sub-1/runs`,
      `DELETE ${base}/sub-1`,
    ]
  );
});
