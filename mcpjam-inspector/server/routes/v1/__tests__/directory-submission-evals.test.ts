/**
 * A directory submission's evals: reading the linked suite, run and results,
 * linking under the revision guard, importing a plugin package's cases, and
 * exporting the suite's cases in ChatGPT's shape.
 *
 * Convex is mocked at `convex/browser`, as in the other submission route
 * tests, so these prove the gateway: what it reads and forwards, how each
 * backend refusal reaches the caller, and what it refuses before a write.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { CHATGPT_PLUGIN_FLOW, CLAUDE_CONNECTOR_FLOW } from "@mcpjam/sdk";

const mocks = vi.hoisted(() => ({ guest: vi.fn(), query: vi.fn(), mutation: vi.fn() }));

vi.mock("../../../services/guest-token.js", () => ({ validateGuestTokenDetailedAsync: mocks.guest }));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(function () {
    return { setAuth: vi.fn(), query: mocks.query, mutation: mocks.mutation };
  }),
}));

import v1Routes from "../index.js";

const PROJECT = "p1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SUBMISSION = "subxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SUITE = "suitexxxxxxxxxxxxxxxxxxxxxxxxxxx";
const RUN = "runxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const VERSION = "verxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const EVALS = `/api/v1/projects/${PROJECT}/directory-submissions/${SUBMISSION}/evals`;
const LINK = "directorySubmissionEvals:setDirectorySubmissionEvals";
const IMPORT = "directorySubmissionEvals:importDirectoryPluginTestCases";

const ROW = {
  id: SUBMISSION,
  projectId: PROJECT,
  serverId: "srvxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  directory: "openai",
  flowId: CHATGPT_PLUGIN_FLOW.id,
  flowVersion: CHATGPT_PLUGIN_FLOW.version,
  answers: [],
  revision: 4,
  createdBy: "user_1",
  pluginVersionId: VERSION,
  createdAt: 5,
  updatedAt: 10,
};
const LINKED = {
  submissionId: SUBMISSION,
  revision: 4,
  suite: { id: SUITE, name: "Sample review cases" },
  run: { id: RUN, runNumber: 2, status: "completed", result: "passed", createdAt: 20, completedAt: 30 },
};
const RESULT = {
  testCaseId: "casexxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  title: "Find an order",
  prompt: "Where is order 1042?",
  expectation: "Names the order's status",
  negative: false,
  source: { pluginVersionId: VERSION, list: "positive", index: 0 },
  assertions: "judge",
  judge: { enforced: false, threshold: 0.7 },
  client: { name: "ChatGPT", hostStyle: "chatgpt", engine: "emulated", venue: null },
  trials: { total: 1, passed: 1, failed: 0, pending: 0 },
  iterations: [],
};

type Handler = (args: Record<string, any>) => unknown;
let queries: Record<string, Handler>;
let mutations: Record<string, Handler>;

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

const argsOf = (name: string) =>
  mocks.mutation.mock.calls.filter(([fn]) => nameOf(fn) === name).map(([, args]) => args);

const refuse = (data: Record<string, unknown>) => () => {
  throw new ConvexError(data as never);
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_URL", "https://convex.example.com");
  mocks.guest.mockResolvedValue({ valid: false });
  queries = {
    "directorySubmissions:getDirectorySubmission": () => ROW,
    "directorySubmissionEvals:getDirectorySubmissionEvals": () => ({ ...LINKED, results: [RESULT], truncated: false }),
  };
  mutations = {};
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
});

describe("v1 directory submission evals", () => {
  it.each([
    ["GET", ""],
    ["PATCH", ""],
    ["POST", "/import"],
    ["GET", "/export"],
  ])("denies a guest %s evals%s", async (method, path) => {
    mocks.guest.mockResolvedValue({ valid: true, guestId: "guest_1" });
    const res = await request(method, `${EVALS}${path}`, { token: "guest-jwt", ...(method === "GET" ? {} : { body: {} }) });
    expect(res.status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("404s another project's submission on every route, and writes nothing", async () => {
    queries["directorySubmissions:getDirectorySubmission"] = () => ({ ...ROW, projectId: "p2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    expect((await request("GET", EVALS)).status).toBe(404);
    expect((await request("GET", `${EVALS}/export`)).status).toBe(404);
    expect((await request("PATCH", EVALS, { body: { expectedRevision: 4, suiteId: SUITE } })).status).toBe(404);
    expect((await request("POST", `${EVALS}/import`, { body: {} })).status).toBe(404);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("reads the link and each case's result as the backend records them", async () => {
    expect(await json(request("GET", EVALS))).toEqual({ ...LINKED, results: [RESULT], truncated: false });
    queries["directorySubmissionEvals:getDirectorySubmissionEvals"] = () => null;
    expect((await request("GET", EVALS)).status).toBe(404);
  });

  describe("link", () => {
    it("forwards what the body names, null as an unlink, and nothing it leaves out", async () => {
      mutations[LINK] = () => ({ ...LINKED, revision: 5 });
      const body = await json(request("PATCH", EVALS, { body: { expectedRevision: 4, suiteId: SUITE, runId: RUN, idempotencyKey: "k1" } }));
      expect(body).toMatchObject({ revision: 5, suite: { id: SUITE } });
      mutations[LINK] = () => ({ ...LINKED, suite: null, run: null, revision: 6, replayed: true });
      expect((await json(request("PATCH", EVALS, { body: { expectedRevision: 5, suiteId: null } }))).replayed).toBe(true);
      expect(argsOf(LINK)).toEqual([
        { submissionId: SUBMISSION, expectedRevision: 4, suiteId: SUITE, runId: RUN, idempotencyKey: "k1" },
        { submissionId: SUBMISSION, expectedRevision: 5, suiteId: null },
      ]);
    });

    it.each([
      ["an unknown key", { expectedRevision: 4, suite: SUITE }, 400],
      ["no expected revision", { suiteId: SUITE }, 400],
      ["a suite id of the wrong shape", { expectedRevision: 4, suiteId: "suite-1" }, 404],
      ["a run id of the wrong shape", { expectedRevision: 4, runId: "run 1" }, 404],
    ])("refuses %s before the backend sees it", async (_label, body, status) => {
      expect((await request("PATCH", EVALS, { body })).status).toBe(status);
      expect(mocks.mutation).not.toHaveBeenCalled();
    });

    it("refuses a stale revision with the current one and the keys that changed", async () => {
      const message = "Someone changed this submission since you read it. Read it again, then retry.";
      mutations[LINK] = refuse({ code: "CONFLICT", message, currentRevision: 7, conflictingKeys: ["evalSuite"] });
      const res = await request("PATCH", EVALS, { body: { expectedRevision: 4, suiteId: SUITE } });
      expect(res.status).toBe(409);
      expect(await json(res)).toMatchObject({ code: "CONFLICT", message, details: { currentRevision: 7, conflictingKeys: ["evalSuite"] } });
    });

    it.each([
      [{ code: "NOT_FOUND", message: "Eval run not found. Pick a run of the linked suite." }, 404, "NOT_FOUND"],
      [{ code: "VALIDATION", message: "That run is not a run of this submission's eval suite." }, 400, "VALIDATION_ERROR"],
      [{ code: "FEATURE_UNAVAILABLE", message: "Directory readiness is not available.", feature: "directory-readiness" }, 403, "FORBIDDEN"],
    ])("answers the backend's %o with its own sentence", async (data, status, code) => {
      mutations[LINK] = refuse(data);
      const res = await request("PATCH", EVALS, { body: { expectedRevision: 4, runId: RUN } });
      expect(res.status).toBe(status);
      expect(await json(res)).toMatchObject({ code, message: data.message });
    });
  });

  describe("import", () => {
    const IMPORTED = {
      suiteId: SUITE,
      pluginVersionId: VERSION,
      created: 1,
      existing: 1,
      cases: [{ list: "positive", index: 0, testCaseId: RESULT.testCaseId, created: true }],
      skipped: [{ list: "negative", index: 2, reason: "missing_prompt" }],
    };

    it("imports the version the submission names, checked against the one sent", async () => {
      mutations[IMPORT] = () => IMPORTED;
      expect(await json(request("POST", `${EVALS}/import`))).toEqual(IMPORTED);
      await request("POST", `${EVALS}/import`, { body: { pluginVersionId: VERSION } });
      expect(argsOf(IMPORT)).toEqual([{ submissionId: SUBMISSION }, { submissionId: SUBMISSION, pluginVersionId: VERSION }]);
      expect((await request("POST", `${EVALS}/import`, { body: { pluginVersionId: "v1" } })).status).toBe(404);
      expect((await request("POST", `${EVALS}/import`, { body: { version: VERSION } })).status).toBe(400);
      expect(argsOf(IMPORT)).toHaveLength(2);
    });

    it.each([
      ["no_eval_suite", "This submission has no eval suite. Link a suite in its project, then import the test cases."],
      ["no_plugin_version", "This submission names no plugin version. Choose the version it rehearses, then import its test cases."],
      ["plugin_version_not_applicable", "A claude-connector submission has no plugin package to import test cases from."],
      ["plugin_version_not_ready", "This plugin version is still importing or failed to import. Pick a ready version of the plugin."],
      ["submission_mismatch", "The submission now names a different plugin version. Reload it, then import the version it names."],
      ["CI_OWNED_SUITE_READ_ONLY", "This suite is managed by CI. Edit the test file in your repository and run it again."],
    ])("answers %s with 409, its sentence and its code", async (code, message) => {
      mutations[IMPORT] = refuse({ code, message });
      const res = await request("POST", `${EVALS}/import`);
      expect(res.status).toBe(409);
      expect(await json(res)).toMatchObject({ code: "CONFLICT", message, details: { code } });
    });

    it("answers a missing plugin version with the backend's 404 sentence", async () => {
      const message = "Plugin version not found. Pick a version of a plugin in this project.";
      mutations[IMPORT] = refuse({ code: "NOT_FOUND", message });
      const res = await request("POST", `${EVALS}/import`);
      expect(res.status).toBe(404);
      expect(await json(res)).toMatchObject({ code: "NOT_FOUND", message });
    });
  });

  describe("export", () => {
    const stored = (id: string, fields: Record<string, unknown>) => ({ _id: `${id}xxxxxxxxxxxxxxxxxxxxxxxxxxxxx`, title: id, query: `Prompt ${id}`, ...fields });

    it("writes the suite's cases as ChatGPT's two lists, and names the ones the form would refuse", async () => {
      queries["testSuites:listTestCases"] = ({ suiteId }) => {
        expect(suiteId).toBe(SUITE);
        return [
          stored("ok1", { expectedOutput: " Lists the open orders. " }),
          stored("neg", { isNegativeTest: true, scenario: "Declines to delete an account." }),
          // A scenario explains only a negative case's expectation.
          stored("bare", { scenario: "Context only.", expectedToolCalls: [{ toolName: "find_order", arguments: {} }] }),
          stored("neg2", { isNegativeTest: true, expectedOutput: "Asks which order.", scenario: "Ambiguous request." }),
          stored("blank", { query: "  ", expectedOutput: "Anything." }),
        ];
      };
      const file = await json(request("GET", `${EVALS}/export`));
      const testCases = {
        successful: [{ prompt: "Prompt ok1", expectation: "Lists the open orders." }],
        gracefulFailure: [
          { prompt: "Prompt neg", expectation: "Declines to delete an account." },
          { prompt: "Prompt neg2", expectation: "Asks which order." },
        ],
      };
      expect(file).toEqual({
        submissionId: SUBMISSION,
        directory: "openai",
        suite: LINKED.suite,
        counts: { successful: 1, gracefulFailure: 2 },
        required: { successful: 5, gracefulFailure: 3 },
        omitted: [
          { testCaseId: stored("bare", {})._id, title: "bare", negative: false, reason: "no_expectation" },
          { testCaseId: stored("blank", {})._id, title: "blank", negative: false, reason: "no_prompt" },
        ],
        filename: `chatgpt-plugin-${SUBMISSION}-test-cases.json`,
        mediaType: "application/json",
        content: `${JSON.stringify(testCases, null, 2)}\n`,
      });
    });

    it("says Claude's directory takes no test cases, and reads no suite", async () => {
      queries["directorySubmissions:getDirectorySubmission"] = () => ({ ...ROW, directory: "claude", flowId: CLAUDE_CONNECTOR_FLOW.id });
      const res = await request("GET", `${EVALS}/export`);
      expect(res.status).toBe(409);
      expect((await json(res)).message).toMatch(/^Claude's directory takes no test cases.*Use cases step instead\.$/);
      expect(mocks.query.mock.calls.map(([fn]) => nameOf(fn))).toEqual(["directorySubmissions:getDirectorySubmission"]);
    });

    it("refuses a submission with no linked suite", async () => {
      queries["directorySubmissionEvals:getDirectorySubmissionEvals"] = () => ({ ...LINKED, suite: null, run: null, results: [], truncated: false });
      const res = await request("GET", `${EVALS}/export`);
      expect(res.status).toBe(409);
      expect((await json(res)).message).toMatch(/no eval suite\. Link a suite/);
    });
  });
});
