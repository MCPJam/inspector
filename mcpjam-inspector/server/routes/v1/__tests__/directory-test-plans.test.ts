/**
 * A directory submission's test plan: reading a revision, drafting from the
 * server's stored tool list, saving under the revision guard, starting a run
 * with a revision, and grading a run's calls from its ledger.
 *
 * Convex is mocked at `convex/browser` and the tool list reads at `fetch`, as
 * in the other submission route tests, so these prove the gateway: what it
 * reads, what it forwards, and what it refuses before anything is written.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import {
  CLAUDE_CONNECTOR_FLOW,
  draftDirectoryTestPlan,
  validateDirectoryTestPlan,
  type DirectoryTestPlan,
} from "@mcpjam/sdk";

const mocks = vi.hoisted(() => ({
  guest: vi.fn(),
  query: vi.fn(),
  mutation: vi.fn(),
  authorize: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({ validateGuestTokenDetailedAsync: mocks.guest }));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(function () {
    return { setAuth: vi.fn(), query: mocks.query, mutation: mocks.mutation };
  }),
}));
vi.mock("../../../services/readiness/worker.js", () => ({ executeHostedReadinessRun: mocks.execute }));
vi.mock("../../web/auth.js", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../web/auth.js")),
  authorizeServer: mocks.authorize,
}));

import v1Routes from "../index.js";

const PROJECT = "p1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SUBMISSION = "subxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SERVER = "srvxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const RUN = "runxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const OLD_RUN = "runoldxxxxxxxxxxxxxxxxxxxxxxxxxx";
const ONE = `/api/v1/projects/${PROJECT}/directory-submissions/${SUBMISSION}`;

const ROW = {
  id: SUBMISSION,
  projectId: PROJECT,
  serverId: SERVER,
  directory: "claude",
  flowId: CLAUDE_CONNECTOR_FLOW.id,
  flowVersion: CLAUDE_CONNECTOR_FLOW.version,
  answers: [],
  revision: 3,
  createdBy: "user_1",
  lastRunId: RUN,
  createdAt: 5,
  updatedAt: 10,
};

/** The stored tool list, as the server revision read returns it: hints only, no `$` keys. */
const CATALOG_TOOLS = [
  { name: "search_docs", annotations: { readOnlyHint: true }, inputSchema: { type: "object", required: ["query"] } },
  { name: "list_projects", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } },
  { name: "create_note", annotations: { destructiveHint: false }, inputSchema: { type: "object", required: ["title"] } },
  { name: "delete_note", inputSchema: { type: "object", required: ["id"] } },
];
const TOOLS = CATALOG_TOOLS.map(({ name, annotations, inputSchema }) => ({ name, inputSchema, ...(annotations ? { annotations } : {}) }));

const ref = { $fixture: "note", value: "id" };
/** A plan whose calls the ledger below records. */
const PLAN: DirectoryTestPlan = {
  schemaVersion: 1,
  fixtures: [{ id: "note", description: "A note the plan creates", origin: "created", capture: { id: "note.id" } }],
  tools: [
    { tool: "search_docs", effect: "read", openWorld: false, action: "run", writes: [] },
    { tool: "list_projects", effect: "read", openWorld: false, action: "excluded", exclusion: { reason: "costly" }, writes: [] },
    { tool: "create_note", effect: "write", openWorld: false, action: "run", writes: ["note"] },
    { tool: "delete_note", effect: "destructive", openWorld: false, action: "run", writes: ["note"] },
  ],
  cases: [
    { id: "create_note#valid", tool: "create_note", kind: "valid", arguments: { title: "Sample" }, creates: ["note"] },
    { id: "search_docs#valid", tool: "search_docs", kind: "valid", arguments: { query: "pricing" } },
    { id: "search_docs#missing-arguments", tool: "search_docs", kind: "negative", arguments: {} },
    { id: "delete_note#valid", tool: "delete_note", kind: "valid", arguments: { id: ref } },
  ],
  budget: { maxCalls: 4, concurrency: 1, callTimeoutMs: 30_000 },
  cleanup: [{ fixture: "note", tool: "delete_note", arguments: { id: ref } }],
};
const stored = (revision: number, plan: unknown = PLAN) => ({
  submissionId: SUBMISSION,
  revision,
  counts: { tools: 4, cases: 4, fixtures: 1, cleanup: 1 },
  savedBy: "user_1",
  savedAt: 50,
  plan: JSON.stringify(plan),
});

type Handler = (args: Record<string, any>) => unknown;
let queries: Record<string, Handler>;
let mutations: Record<string, Handler>;
let revisions: { status: number; body: unknown };
let revision: { status: number; body: unknown };
let report: { status: number; body: unknown };

const nameOf = (value: unknown) => (typeof value === "string" ? value : getFunctionName(value as never));

function request(method: string, path: string, opts: { body?: unknown; token?: string } = {}) {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.token ?? "tok"}` },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

async function json(response: Response | Promise<Response>) {
  return (await (await response).json()) as Record<string, any>;
}

const mutationArgs = (name: string) =>
  mocks.mutation.mock.calls.filter(([fn]) => nameOf(fn) === name).map(([, args]) => args);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_URL", "https://convex.example.com");
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex-http.example.com");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
  mocks.guest.mockResolvedValue({ valid: false });
  queries = {
    "directorySubmissions:getDirectorySubmission": () => ROW,
    "directoryTestPlans:getDirectoryTestPlan": ({ revision: named }) => (named === undefined || named === 2 ? stored(2) : null),
  };
  mutations = {};
  revisions = { status: 200, body: { items: [{ revisionNumber: 7, capturedAt: 40, source: "connect", sourceId: null, counts: { tools: 4 } }] } };
  revision = { status: 200, body: { revisionNumber: 7, capturedAt: 40, tools: CATALOG_TOOLS, captureError: null, droppedFields: [] } };
  report = { status: 404, body: {} };
  mocks.query.mockImplementation(async (fn, args) => {
    const handler = queries[nameOf(fn)];
    if (!handler) throw new Error(`unexpected query ${nameOf(fn)}`);
    return handler(args);
  });
  mocks.mutation.mockImplementation(async (fn, args) => {
    const handler = mutations[nameOf(fn)];
    if (!handler) throw new Error(`unexpected mutation ${nameOf(fn)}`);
    return handler(args);
  });
  mocks.authorize.mockResolvedValue({ authorized: true, serverConfig: { transportType: "http", url: "https://mcp.example.com/mcp" } });
  mocks.execute.mockResolvedValue(undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/project-server-revisions") return Response.json(revisions.body, { status: revisions.status });
      if (url.pathname === "/v1/project-server-revision") return Response.json(revision.body, { status: revision.status });
      if (url.pathname === "/internal/v1/claude-readiness/runs/report") return Response.json(report.body, { status: report.status });
      throw new Error(`unexpected fetch ${url}`);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("v1 directory submission test plans", () => {
  it.each([
    ["GET", "/test-plan"],
    ["PUT", "/test-plan"],
    ["GET", "/test-plan/draft"],
    ["GET", "/tool-tests"],
  ])("denies a guest %s %s", async (method, path) => {
    mocks.guest.mockResolvedValue({ valid: true, guestId: "guest_1" });
    const res = await request(method, `${ONE}${path}`, { token: "guest-jwt", ...(method === "PUT" ? { body: {} } : {}) });
    expect(res.status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("404s another project's submission on every route", async () => {
    queries["directorySubmissions:getDirectorySubmission"] = () => ({ ...ROW, projectId: "p2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    for (const path of ["/test-plan", "/test-plan/draft", "/tool-tests"]) {
      expect((await request("GET", `${ONE}${path}`)).status).toBe(404);
    }
    expect((await request("PUT", `${ONE}/test-plan`, { body: { expectedRevision: 2, plan: PLAN } })).status).toBe(404);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  describe("draft", () => {
    it("drafts every tool in the newest stored tool list, with its issues and the revision to save it at", async () => {
      const draft = await json(request("GET", `${ONE}/test-plan/draft`));
      expect(draft.plan).toEqual(draftDirectoryTestPlan(TOOLS));
      expect(draft.issues).toEqual(validateDirectoryTestPlan(draft.plan, TOOLS));
      expect(draft.issues.map((issue: { code: string }) => issue.code)).toContain("argumentsMissing");
      expect(draft).toMatchObject({ catalog: { revisionNumber: 7, capturedAt: 40 }, currentRevision: 2 });
      const urls = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)));
      expect(urls.map((url) => [url.pathname, Object.fromEntries(url.searchParams)])).toEqual([
        ["/v1/project-server-revisions", { projectId: PROJECT, serverId: SERVER, limit: "1" }],
        ["/v1/project-server-revision", { projectId: PROJECT, serverId: SERVER, revisionNumber: "7" }],
      ]);
    });

    it("answers revision 0 to save at before the first plan", async () => {
      queries["directoryTestPlans:getDirectoryTestPlan"] = () => null;
      expect((await json(request("GET", `${ONE}/test-plan/draft`))).currentRevision).toBe(0);
    });

    it.each([
      ["no stored tool list", () => (revisions = { status: 200, body: { items: [] } }), /no stored tool list/],
      ["a failed capture", () => (revision.body = { ...(revision.body as object), captureError: "listing timed out" }), /\(listing timed out\)\. Reconnect/],
      ["no saved server", () => (queries["directorySubmissions:getDirectorySubmission"] = () => ({ ...ROW, serverId: undefined })), /no saved server/],
    ])("refuses with %s", async (_label, arrange, message) => {
      arrange();
      const res = await request("GET", `${ONE}/test-plan/draft`);
      expect(res.status).toBe(409);
      expect((await json(res)).message).toMatch(message);
    });

    it("answers 502 when the tool list cannot be read", async () => {
      revisions = { status: 500, body: { code: "INTERNAL_ERROR", message: "boom" } };
      expect((await request("GET", `${ONE}/test-plan/draft`)).status).toBe(502);
    });
  });

  describe("read", () => {
    it("returns the current plan as an object, checked against the stored tool list", async () => {
      const view = await json(request("GET", `${ONE}/test-plan`));
      expect(view).toMatchObject({ submissionId: SUBMISSION, revision: 2, savedBy: "user_1", plan: PLAN });
      expect(view.issues).toEqual(validateDirectoryTestPlan(PLAN, TOOLS));
      expect(view.catalog).toEqual({ revisionNumber: 7, capturedAt: 40 });
    });

    it("reads a named revision, and 404s one that is not kept", async () => {
      expect((await json(request("GET", `${ONE}/test-plan?revision=2`))).revision).toBe(2);
      const gone = await request("GET", `${ONE}/test-plan?revision=1`);
      expect(gone.status).toBe(404);
      expect((await json(gone)).message).toMatch(/revision 1 is no longer kept/);
      expect((await request("GET", `${ONE}/test-plan?revision=zero`)).status).toBe(400);
    });

    it("404s a submission with no plan, and stays readable without a tool list", async () => {
      revisions = { status: 200, body: { items: [] } };
      expect(await json(request("GET", `${ONE}/test-plan`))).toMatchObject({ plan: PLAN, issues: null, catalog: null });
      queries["directoryTestPlans:getDirectoryTestPlan"] = () => null;
      expect((await request("GET", `${ONE}/test-plan`)).status).toBe(404);
    });

    it("refuses a stored plan it cannot read, rather than serving it", async () => {
      queries["directoryTestPlans:getDirectoryTestPlan"] = () => stored(2, { ...PLAN, tools: "all" });
      const res = await request("GET", `${ONE}/test-plan`);
      expect(res.status).toBe(409);
      expect((await json(res)).message).toMatch(/revision 2 is not in a form MCPJam can read/);
    });
  });

  describe("save", () => {
    const SAVE = "directoryTestPlans:saveDirectoryTestPlan";
    const saved = (replayed?: true) => ({ ...stored(3), plan: undefined, ...(replayed ? { replayed } : {}) });

    it("saves the plan as JSON text at the revision read, and returns its issues", async () => {
      mutations[SAVE] = () => saved();
      const body = await json(request("PUT", `${ONE}/test-plan`, { body: { expectedRevision: 2, plan: PLAN } }));
      expect(mutationArgs(SAVE)).toEqual([{ submissionId: SUBMISSION, expectedRevision: 2, plan: JSON.stringify(PLAN) }]);
      expect(body).toMatchObject({ revision: 3, catalog: { revisionNumber: 7, capturedAt: 40 } });
      expect(body.issues).toEqual(validateDirectoryTestPlan(PLAN, TOOLS));
    });

    it("passes a replayed save on", async () => {
      mutations[SAVE] = () => saved(true);
      expect((await json(request("PUT", `${ONE}/test-plan`, { body: { expectedRevision: 2, plan: PLAN } }))).replayed).toBe(true);
    });

    it("refuses a stale revision with 409 naming the current one", async () => {
      mutations[SAVE] = () => {
        throw new ConvexError({ code: "CONFLICT", message: "The test plan changed since you read it. Read revision 4, then try again.", currentRevision: 4 });
      };
      const res = await request("PUT", `${ONE}/test-plan`, { body: { expectedRevision: 2, plan: PLAN } });
      expect(res.status).toBe(409);
      expect(await json(res)).toMatchObject({ code: "CONFLICT", details: { currentRevision: 4 } });
    });

    it("refuses a plan over a limit with its issues, before the backend sees it", async () => {
      const plan = { ...PLAN, budget: { ...PLAN.budget, concurrency: 9 } };
      const res = await request("PUT", `${ONE}/test-plan`, { body: { expectedRevision: 2, plan } });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.message).toMatch(/^The test plan was not saved\. Concurrency must be/);
      expect(body.details.issues).toEqual([expect.objectContaining({ code: "limit" })]);
      expect(mocks.mutation).not.toHaveBeenCalled();
    });

    it.each([
      ["a misspelled case key", { ...PLAN, cases: [{ ...PLAN.cases[0], argument: {} }] }, 2],
      ["another schema version", { ...PLAN, schemaVersion: 2 }, 2],
      ["a negative expected revision", PLAN, -1],
    ])("refuses %s before anything is written", async (_label, plan, expectedRevision) => {
      const res = await request("PUT", `${ONE}/test-plan`, { body: { expectedRevision, plan } });
      expect(res.status).toBe(400);
      expect(mocks.mutation).not.toHaveBeenCalled();
    });

    it("refuses to save without a stored tool list to check against", async () => {
      revisions = { status: 200, body: { items: [] } };
      const res = await request("PUT", `${ONE}/test-plan`, { body: { expectedRevision: 2, plan: PLAN } });
      expect(res.status).toBe(409);
      expect(mocks.mutation).not.toHaveBeenCalled();
    });
  });

  describe("tool tests", () => {
    const LIST = "claudeReadinessRuns:listReadinessRuns";
    const CALLS = "directoryReadinessCallLedger:getReadinessRunCalls";
    const runRow = (id: string, extra: Record<string, unknown> = {}) => ({ id, status: "running", submissionId: SUBMISSION, hasReport: false, createdAt: 1, updatedAt: 2, ...extra });
    const call = (callKey: string, tool: string, effect: string, phase: string, extra: Record<string, unknown> = {}) => ({
      callKey, tool, effect, phase, inputDigest: "digest", ranBy: { kind: "direct-call" }, attempts: 1, startedAt: 60, ...extra,
    });
    const LEDGER = [
      call("create_note#valid", "create_note", "write", "succeeded", { outcome: "result", captured: [{ fixture: "note", name: "id", value: "n_1" }] }),
      call("search_docs#valid", "search_docs", "read", "succeeded", { outcome: "result" }),
      call("search_docs#missing-arguments", "search_docs", "read", "failed", { outcome: "invalid-arguments" }),
      call("delete_note#valid", "delete_note", "destructive", "started"),
      call("cleanup:note", "delete_note", "destructive", "started"),
    ];

    beforeEach(() => {
      queries[LIST] = () => [runRow("runnewxxxxxxxxxxxxxxxxxxxxxxxxxx"), runRow(RUN, { testPlanRevision: 2 }), runRow(OLD_RUN, { testPlanRevision: 1 })];
      queries["claudeReadinessRuns:getReadinessRun"] = ({ runId }) => (runId === RUN ? runRow(RUN, { testPlanRevision: 2 }) : null);
      queries[CALLS] = () => ({ runId: RUN, testPlanRevision: 2, calls: LEDGER });
    });

    it("grades the newest run that named a plan, valid input apart from negative cases", async () => {
      const body = await json(request("GET", `${ONE}/tool-tests`));
      expect(body.run).toMatchObject({ id: RUN, testPlanRevision: 2 });
      expect(body).toMatchObject({ testPlanRevision: 2, source: "ledger" });
      expect(body).not.toHaveProperty("sweep");
      expect(body.tools.map((tool: { tool: string; status: string }) => [tool.tool, tool.status])).toEqual([
        ["search_docs", "valid-input-succeeded"],
        ["list_projects", "excluded"],
        ["create_note", "valid-input-succeeded"],
        ["delete_note", "ambiguous"],
      ]);
      expect(body.counts.validInput).toMatchObject({ passed: 2, ambiguous: 1 });
      expect(body.counts.negative).toMatchObject({ passed: 1, failed: 0 });
      expect(body.counts.tools).toMatchObject({ "valid-input-succeeded": 2, ambiguous: 1, excluded: 1 });
      expect(mocks.query.mock.calls.filter(([fn]) => nameOf(fn) === CALLS).map(([, args]) => args)).toEqual([{ runId: RUN }]);
    });

    it("names every call in doubt, cleanup included, and keeps cleanup calls apart", async () => {
      const body = await json(request("GET", `${ONE}/tool-tests`));
      expect(body.inDoubt.map((record: { callKey: string }) => record.callKey)).toEqual(["delete_note#valid", "cleanup:note"]);
      expect(body.cleanup.map((record: { callKey: string }) => record.callKey)).toEqual(["cleanup:note"]);
      const created = body.tools.find((tool: { tool: string }) => tool.tool === "create_note").cases[0].call;
      expect(created).toEqual({
        callKey: "create_note#valid", tool: "create_note", phase: "succeeded", inputDigest: "digest", ranBy: { kind: "direct-call" },
        startedAt: 60, outcome: "result", captured: { note: { id: "n_1" } }, planRevision: 2,
      });
    });

    it("reads the run named, and 404s a run of another submission", async () => {
      expect((await json(request("GET", `${ONE}/tool-tests?runId=${RUN}`))).run.id).toBe(RUN);
      expect((await request("GET", `${ONE}/tool-tests?runId=${OLD_RUN}`)).status).toBe(404);
    });

    it.each([
      ["cancelled", "untested", /cancelled before this case/],
      ["failed", "blocked", /The run failed before this case/],
    ])("says why a %s run never reached a case", async (status, caseStatus, reason) => {
      queries[LIST] = () => [runRow(RUN, { status, testPlanRevision: 2 })];
      queries[CALLS] = () => ({ runId: RUN, testPlanRevision: 2, calls: LEDGER.slice(0, 1) });
      const search = (await json(request("GET", `${ONE}/tool-tests`))).tools[0];
      expect(search.cases[0]).toMatchObject({ caseId: "search_docs#valid", status: caseStatus, reason: expect.stringMatching(reason) });
    });

    it("answers no tool tests before a run names a plan", async () => {
      queries[LIST] = () => [runRow(RUN)];
      expect(await json(request("GET", `${ONE}/tool-tests`))).toMatchObject({ run: null, testPlanRevision: null, source: null, tools: [], inDoubt: [] });
      queries["claudeReadinessRuns:getReadinessRun"] = () => runRow(RUN);
      expect(await json(request("GET", `${ONE}/tool-tests?runId=${RUN}`))).toMatchObject({ run: { id: RUN }, testPlanRevision: null, tools: [] });
    });

    it("serves a finished run's own summary from its report, with why the sweep ended", async () => {
      const issues = [{ code: "missingTool", message: "send_invoice is not in the plan. Add a case for it, or exclude it with a reason.", tool: "send_invoice" }];
      const doubted = { callKey: "cleanup:note", tool: "delete_note", phase: "ambiguous", inputDigest: "digest", ranBy: { kind: "direct-call" } };
      const tools = [{ tool: "search_docs", status: "setup-blocked", validInput: {}, negative: {}, cases: [] }];
      const reason = "The test plan does not match the tools the server lists now, so no tool was called.";
      const toolTests = { planRevision: 2, status: "not-run", reason, issues, ambiguous: ["cleanup:note"], tools, cleanup: [doubted] };
      report = { status: 200, body: { findings: [], toolTests } };
      queries[LIST] = () => [runRow(RUN, { status: "completed", hasReport: true, testPlanRevision: 2 })];
      const body = await json(request("GET", `${ONE}/tool-tests`));
      expect(body).toMatchObject({ source: "report", testPlanRevision: 2, sweep: { status: "not-run", reason, issues }, tools, cleanup: [doubted] });
      expect(body.inDoubt).toEqual([doubted]);
      expect(mocks.query.mock.calls.some(([fn]) => nameOf(fn) === CALLS)).toBe(false);
    });

    it("passes on the arguments a run drafted, as proposals, and only from its report", async () => {
      const drafting = {
        status: "completed",
        drafts: [{ caseId: "search_docs#valid", arguments: { query: "pricing" }, rationale: "A query the docs answer." }],
        undecided: [{ caseId: "delete_note#valid", reason: "needs_fixture" }],
        dropped: { schema: 1, credential: 0 },
        unsent: 2,
        modelId: "model_1",
      };
      const toolTests = { planRevision: 2, status: "not-run", reason: "Not run.", ambiguous: [], tools: [], cleanup: [], drafting };
      report = { status: 200, body: { findings: [], toolTests } };
      queries[LIST] = () => [runRow(RUN, { status: "completed", hasReport: true, testPlanRevision: 2 })];
      expect((await json(request("GET", `${ONE}/tool-tests`))).drafting).toEqual(drafting);
      // Drafting an unreadable shape, or a run still going, carries none.
      report = { status: 200, body: { findings: [], toolTests: { ...toolTests, drafting: { status: "completed", drafts: "all" } } } };
      expect(await json(request("GET", `${ONE}/tool-tests`))).not.toHaveProperty("drafting");
      queries[LIST] = () => [runRow(RUN, { testPlanRevision: 2 })];
      expect(await json(request("GET", `${ONE}/tool-tests`))).not.toHaveProperty("drafting");
    });

    it.each([
      ["no tool tests", {}],
      ["tool tests it cannot read", { toolTests: { status: "completed", tools: "all" } }],
    ])("grades the ledger when a finished run's report holds %s", async (_label, extra) => {
      report = { status: 200, body: { findings: [], ...extra } };
      queries[LIST] = () => [runRow(RUN, { status: "completed", hasReport: true, testPlanRevision: 2 })];
      expect(await json(request("GET", `${ONE}/tool-tests`))).toMatchObject({ source: "ledger", testPlanRevision: 2 });
    });

    it("refuses when the run's plan revision is no longer kept", async () => {
      queries["directoryTestPlans:getDirectoryTestPlan"] = () => null;
      const res = await request("GET", `${ONE}/tool-tests`);
      expect(res.status).toBe(409);
      expect((await json(res)).message).toMatch(/revision 2 is no longer kept/);
    });
  });
});
