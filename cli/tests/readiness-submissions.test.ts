/**
 * `mcpjam readiness flows` and `mcpjam readiness submission`.
 *
 * What these pin: each verb sends the route and body the submissions API
 * documents; `--answer` values are read as JSON when they parse and as text
 * otherwise, and a bad one is refused before any request; a conflict is
 * retried only with `--retry-on-conflict`; `run --wait` and `results` exit
 * with the readiness codes for the run judged under the submission's gate,
 * name that gate, and never exit 1 for a run that graded nothing; and `gate`
 * changes the gate it read without overwriting one saved in between.
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

type Reply = { status?: number; body: unknown };
type Captured = { key: string; query: Record<string, string>; body: unknown };

/** The API the commands reach. Each key answers its replies in order. */
function stubFetch(routes: Record<string, Reply[]>): Captured[] {
  const requests: Captured[] = [];
  globalThis.fetch = (async (target: unknown, init?: RequestInit) => {
    const url = new URL(String(target));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    if (key.endsWith("/projects")) return Response.json({ items: [PROJECT] });
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

const LISTING = "claude.submission.listing-fields";
const URLS = "claude.submission.urls";
const RFC8707 = "claude.auth.rfc8707-resource-canonical";
const REGISTRATION = "claude.intrusive.dynamic-registration";

/** A finding as the results route places it, raw `details` included. */
function placed(id: string, finding: Record<string, unknown> = {}) {
  const status = finding.status ?? "satisfied";
  return {
    finding: {
      id,
      title: id,
      lane: "submission-artifacts",
      class: "required",
      provenance: "declared",
      intrusiveness: "passive",
      evaluatedAt: "2026-11-13T00:00:00.000Z",
      engineVersion: "test",
      ...finding,
      status,
    },
    step: "listing",
    evidenceStatus: status === "not-evaluated" ? "not-tested" : "established",
  };
}

const COUNTS = { toFix: 0, blockers: 0, likelyFlags: 0, notChecked: 0, passed: 0 };

/** The results route's answer: one run's findings and the gate as it is now. */
function resultsOf(findings: unknown[], checkGate: unknown = null): Reply {
  return {
    body: {
      run: runRow("completed", "not-ready"),
      steps: [{ step: "listing", fieldIssues: [], findings, counts: COUNTS }],
      counts: COUNTS,
      checkGate,
    },
  };
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

test("run --wait exits 1 when a check in the gate failed, and names the gate", async () => {
  const requests = stubFetch({
    [`POST ${BASE}/sub-1/runs`]: [{ status: 202, body: RECEIPT }],
    "GET /api/v1/projects/project-1/readiness-runs/run-1": [
      { body: runRow("completed", "not-ready") },
    ],
    [`GET ${BASE}/sub-1/results`]: [resultsOf([placed(LISTING, { status: "violated" }), placed(URLS)])],
  });
  const waited = await run(["submission", "run", "sub-1", "--wait"]);
  assert.equal((waited.printed.run as { status: string }).status, "completed");
  // The results of the run it waited for, not the latest complete one.
  assert.deepEqual(requests.at(-1)!.query, { runId: "run-1" });
  assert.deepEqual(waited.printed.verdict, {
    verdict: "not-ready",
    failing: [LISTING],
    undetermined: [],
    notCheckedOnPath: [],
    notCheckedReasons: {},
    gate: { failOn: [], warnOnly: [] },
  });
  assert.match(waited.stderr, /^NOT READY.*checks in the gate failed: claude\.submission\.listing-fields$/m);
  assert.match(waited.stderr, /^Gate: the directory's blocking checks$/m);
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
    [`GET ${BASE}/sub-1/results`]: [resultsOf([placed(LISTING)])],
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

test("run --wait exits 3 when a finished run's results cannot be read, and says how to read them", async () => {
  stubFetch({
    [`POST ${BASE}/sub-1/runs`]: [{ status: 202, body: RECEIPT }],
    [`GET ${RUN_PATH}`]: [{ body: runRow("completed", "ready") }],
    [`GET ${BASE}/sub-1/results`]: [
      {
        status: 502,
        body: {
          code: "INTERNAL_ERROR",
          message: "The readiness report could not be read from storage. Try again in a minute.",
        },
      },
    ],
  });
  await assert.rejects(run(["submission", "run", "sub-1", "--wait"]), (error: unknown) => {
    assert.ok(error instanceof CliError, String(error));
    assert.equal(error.exitCode, 3);
    assert.match(error.message, /The run finished\. Read its results with `mcpjam readiness submission results sub-1 --run run-1`\./);
    return true;
  });
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

test("results exits 3 before any run has completed, and says how to start one", async () => {
  const requests = stubFetch({
    [`GET ${BASE}/sub-1/results`]: [{ body: { run: null, steps: [], counts: COUNTS } }],
  });
  const results = await run(["submission", "results", "sub-1", "--run", "run-1", "--json"]);
  assert.deepEqual(requests[0]!.query, { runId: "run-1" });
  assert.equal(results.printed.submissionId, "sub-1");
  assert.match(results.stderr, /^INCOMPLETE.*no run has completed\. Start one with `mcpjam readiness submission run sub-1 --wait`\.$/m);
  assert.equal(process.exitCode, 3);
});

type Verdict = { verdict: string; gate: { failOn: string[]; warnOnly: string[] } };
type PrintedSteps = Array<{ findings: Array<{ finding: Record<string, unknown> }> }>;

test("V8: a Listing check moved to warn only still shows, the exit code ignores it, and the output names the gate", async () => {
  const findings = [placed(LISTING, { status: "violated" }), placed(URLS)];
  const gate = { warnOnly: [LISTING] };
  stubFetch({
    [`POST ${BASE}/sub-1/runs`]: [{ status: 202, body: RECEIPT }],
    // The run's own rollup says not ready: only the gate can clear it.
    [`GET ${RUN_PATH}`]: [{ body: runRow("completed", "not-ready") }],
    [`GET ${BASE}/sub-1/results`]: [resultsOf(findings, gate), resultsOf(findings, gate)],
  });
  const waited = await run(["submission", "run", "sub-1", "--wait"]);
  const verdict = waited.printed.verdict as Verdict;
  assert.equal(verdict.verdict, "ready");
  assert.deepEqual(verdict.gate, { failOn: [], warnOnly: [LISTING] });
  assert.match(waited.stderr, /^READY$/m);
  assert.match(waited.stderr, /^Gate: the directory's blocking checks\n {2}Warn only: claude\.submission\.listing-fields$/m);
  assert.equal(process.exitCode, 0);

  process.exitCode = 0;
  const shown = await run(["submission", "results", "sub-1", "--json"]);
  const listed = (shown.printed.steps as PrintedSteps)[0]!.findings.map((entry) => entry.finding);
  assert.deepEqual(
    listed.map((finding) => [finding.id, finding.status]),
    [[LISTING, "violated"], [URLS, "satisfied"]]
  );
  assert.equal((shown.printed.verdict as Verdict).verdict, "ready");
  assert.match(shown.stderr, /Warn only: claude\.submission\.listing-fields/);
  assert.equal(process.exitCode, 0);
});

test("results fails the run on a check failOn names, even one warnOnly names too", async () => {
  const heuristic = "claude.tools.description-quality";
  stubFetch({
    [`GET ${BASE}/sub-1/results`]: [
      resultsOf(
        [placed(heuristic, { class: "heuristic", status: "violated" }), placed(URLS)],
        { failOn: [heuristic], warnOnly: [heuristic, LISTING] }
      ),
    ],
  });
  const shown = await run(["submission", "results", "sub-1"]);
  const verdict = shown.printed.verdict as Verdict;
  assert.equal(verdict.verdict, "not-ready");
  assert.deepEqual(verdict.gate, { failOn: [heuristic], warnOnly: [LISTING] });
  assert.match(shown.stderr, /^ {2}Also fail on: claude\.tools\.description-quality$/m);
  assert.match(shown.stderr, /^ {2}Warn only: claude\.submission\.listing-fields$/m);
  assert.equal(process.exitCode, 1);
});

test("results exits 3 for a gated check without a result, and lists what a hosted run cannot check", async () => {
  stubFetch({
    [`GET ${BASE}/sub-1/results`]: [
      resultsOf([
        placed(URLS),
        placed(LISTING, { status: "not-evaluated", notEvaluatedReason: "no answers" }),
        placed(REGISTRATION, { status: "not-evaluated", intrusiveness: "side-effecting" }),
        // Only the raw details say this one needs a recorded sign-in.
        placed(RFC8707, { status: "not-evaluated", details: { missingInput: "authorizationRequests" } }),
      ]),
    ],
  });
  const shown = await run(["submission", "results", "sub-1", "--json"]);
  assert.match(shown.stderr, /^INCOMPLETE.*checks in the gate have no current result: claude\.submission\.listing-fields$/m);
  assert.match(shown.stderr, /^Not checked on hosted runs \(2\):$/m);
  assert.match(shown.stderr, /^ {2}claude\.auth\.rfc8707-resource-canonical: it reads the requests of a completed OAuth sign-in/m);
  assert.match(shown.stderr, /^ {2}claude\.intrusive\.dynamic-registration: hosted runs never make probes that change the server/m);
  // Judged before the details were left out of what is printed.
  const printed = (shown.printed.steps as PrintedSteps)[0]!.findings.map((entry) => entry.finding);
  assert.ok(printed.every((finding) => !("details" in finding)));
  assert.equal(process.exitCode, 3);
});

test("results exits 3, never 1, when the results cannot be read", async () => {
  stubFetch({
    [`GET ${BASE}/sub-1/results`]: [
      { status: 404, body: { code: "NOT_FOUND", message: "Directory submission not found" } },
    ],
  });
  await assert.rejects(
    run(["submission", "results", "sub-1"]),
    (error: unknown) => error instanceof CliError && error.exitCode === 3
  );
});

test("gate moves each named check to its list, keeps the other choices, and saves at the revision it read", async () => {
  const current = { failOn: ["claude.a"], warnOnly: ["claude.b", LISTING] };
  const next = { failOn: ["claude.a", LISTING], warnOnly: ["claude.b", "claude.c"] };
  const requests = stubFetch({
    [`GET ${BASE}/sub-1`]: [{ body: { ...VIEW, checkGate: current } }],
    [`PATCH ${BASE}/sub-1`]: [{ body: { ...VIEW, revision: 5, checkGate: next } }],
  });
  const saved = await run(["submission", "gate", "sub-1", "--fail-on", LISTING, "--warn-only", " claude.c "]);
  const body = requests[1]!.body as Record<string, unknown>;
  assert.deepEqual(body.checkGate, next);
  assert.equal(body.expectedRevision, 4);
  assert.equal(body.answers, undefined);
  assert.deepEqual((saved.printed.submission as { checkGate: unknown }).checkGate, next);
  assert.match(saved.stderr, /^ {2}Also fail on: claude\.a, claude\.submission\.listing-fields$/m);
});

test("gate --clear starts from the directory's own blocking checks", async () => {
  const requests = stubFetch({
    [`GET ${BASE}/sub-1`]: [
      { body: { ...VIEW, checkGate: { failOn: ["claude.a"] } } },
      { body: { ...VIEW, checkGate: { failOn: ["claude.a"] } } },
    ],
    [`PATCH ${BASE}/sub-1`]: [{ body: VIEW }, { body: VIEW }],
  });
  const cleared = await run(["submission", "gate", "sub-1", "--clear"]);
  await run(["submission", "gate", "sub-1", "--clear", "--warn-only", LISTING]);
  const patches = requests.filter((request) => request.key === `PATCH ${BASE}/sub-1`);
  assert.deepEqual(
    patches.map((request) => (request.body as { checkGate: unknown }).checkGate),
    [null, { warnOnly: [LISTING] }]
  );
  assert.match(cleared.stderr, /^Gate: the directory's blocking checks$/m);
});

test("gate refuses a change that says nothing or names a check twice, before any request", async () => {
  const requests = stubFetch({});
  const gate = (...args: string[]) => run(["submission", "gate", "sub-1", ...args]);
  await assert.rejects(gate(), rejectsWith("USAGE_ERROR", /Nothing to change/));
  await assert.rejects(
    gate("--fail-on", LISTING, "--warn-only", LISTING),
    rejectsWith("USAGE_ERROR", /claude\.submission\.listing-fields is given to both --fail-on and --warn-only/)
  );
  await assert.rejects(gate("--fail-on", " "), rejectsWith("USAGE_ERROR", /checkGate\.failOn\.0/));
  assert.deepEqual(requests, []);
});

test("gate answers a conflict with the gate as it is now, and does not overwrite it", async () => {
  const theirs = { failOn: ["claude.z"] };
  const requests = stubFetch({
    [`GET ${BASE}/sub-1`]: [{ body: VIEW }],
    [`PATCH ${BASE}/sub-1`]: [
      {
        status: 409,
        body: {
          code: "CONFLICT",
          message: "This submission changed since you read it. Read it again and reapply your change.",
          details: {
            currentRevision: 6,
            conflictingKeys: ["checkGate"],
            current: { ...VIEW, revision: 6, checkGate: theirs },
          },
        },
      },
    ],
  });
  await assert.rejects(run(["submission", "gate", "sub-1", "--warn-only", LISTING]), (error: unknown) => {
    assert.ok(error instanceof CliError, String(error));
    assert.equal(error.code, "CONFLICT");
    assert.equal(error.exitCode, 1);
    assert.match(error.message, /check gate changed while yours was saving\. Run the command again/);
    assert.deepEqual(error.details, {
      currentRevision: 6,
      conflictingKeys: ["checkGate"],
      checkGate: theirs,
    });
    return true;
  });
  assert.equal(requests.filter((request) => request.key === `PATCH ${BASE}/sub-1`).length, 1);
});
