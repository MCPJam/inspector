import { beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  action: vi.fn(),
  mutation: vi.fn(),
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query(...args: unknown[]) {
      return mocks.query(...args);
    }
    action(...args: unknown[]) {
      return mocks.action(...args);
    }
    mutation(...args: unknown[]) {
      return mocks.mutation(...args);
    }
  },
}));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "actor-token",
}));
import router from "../eval-backtest";
import { v1OnError } from "../envelope";
const app = new Hono().route("/api/v1", router);
app.onError(v1OnError);
const url = "/api/v1/projects/project/eval-runs/run/regrade";
const post = (body?: unknown) =>
  app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const messages = [{ role: "assistant", content: "Found 3 cats." }];
const failingRow = {
  predicate: { type: "responseContains", needle: "dogs" },
  passed: false,
  reason: 'final assistant message does not contain "dogs"',
};
const evidencePage = {
  schemaVersion: 1,
  runId: "run",
  suiteId: "suite",
  isDone: true,
  iterations: [
    {
      iterationId: "iteration",
      caseId: "case",
      status: "completed",
      result: "failed",
      updatedAt: 5,
      gradingRevision: 0,
      actualToolCalls: [],
      expectedToolCalls: [],
      isNegativeTest: false,
      predicates: [{ type: "responseContains", needle: "dogs" }],
      caseShape: { turns: 1, transcriptOnly: true },
      recorded: { predicateResults: [failingRow], scoreRows: "none" },
      evidence: { traceVersion: 1, traceComplete: true, messages },
      completeness: { transcript: "complete" },
    },
  ],
};

beforeEach(() => {
  vi.stubEnv("CONVEX_URL", "https://convex.test");
  mocks.query
    .mockReset()
    .mockResolvedValue({ projectId: "project", suiteId: "suite" });
  mocks.action.mockReset().mockResolvedValue(evidencePage);
  mocks.mutation.mockReset().mockResolvedValue({
    regraded: 1,
    flipped: 1,
    result: "passed",
    summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
    iterations: [{ iterationId: "iteration", gradingRevision: 1 }],
  });
});

const draft = {
  assertions: {
    mode: "replace",
    list: [{ type: "responseContains", needle: "cats" }],
  },
};

it("re-grades from stored evidence and persists through the guarded mutation", async () => {
  const response = await post(draft);
  expect(response.status).toBe(200);
  expect(mocks.action).toHaveBeenCalledWith("evalRegrade:readRegradeEvidence", {
    runId: "run",
    pageSize: 5,
  });
  expect(mocks.mutation).toHaveBeenCalledWith(
    "evalRegrade:applyRunRegrade",
    expect.objectContaining({
      runId: "run",
      iterations: [
        expect.objectContaining({
          iterationId: "iteration",
          expectedGradingRevision: 0,
          expectedUpdatedAt: 5,
          result: "passed",
        }),
      ],
    }),
  );
  const body = await response.json();
  expect(body).toMatchObject({
    applied: true,
    run: { result: "passed" },
    counts: { regraded: 1, flipped: 1 },
    modelUse: "none",
  });
});

it("a dry run returns the diff without writing", async () => {
  const response = await post({ ...draft, dryRun: true });
  expect(response.status).toBe(200);
  expect(mocks.mutation).not.toHaveBeenCalled();
  expect(await response.json()).toMatchObject({
    dryRun: true,
    applied: false,
    counts: { regraded: 1 },
  });
});

it("an empty body re-grades the frozen rules", async () => {
  const response = await post();
  expect(response.status).toBe(200);
  // The frozen rule still fails, so nothing changed and nothing is written.
  expect(mocks.mutation).not.toHaveBeenCalled();
  expect(await response.json()).toMatchObject({
    counts: { unchanged: 1, regraded: 0 },
  });
});

it("validates before reading evidence, and refuses match-option drafts", async () => {
  expect((await post({ assertions: { mode: "nope", list: [] } })).status).toBe(
    400,
  );
  expect(
    (await post({ ...draft, matchOptions: { argumentMatching: "ignore" } }))
      .status,
  ).toBe(400);
  expect(mocks.action).not.toHaveBeenCalled();
});

it("binds the run to the path project", async () => {
  mocks.query.mockResolvedValue({ projectId: "other", suiteId: "suite" });
  expect((await post(draft)).status).toBe(404);
  expect(mocks.action).not.toHaveBeenCalled();
});

it.each([
  ["EVAL_REGRADE_STALE: the iteration changed", "CONFLICT", 409],
  [
    "EVAL_RUN_NOT_REGRADABLE: re-grade requires a completed run",
    "CONFLICT",
    409,
  ],
  ["private backend context", "VALIDATION_ERROR", 400],
  ["private backend context", "NOT_FOUND", 404],
])(
  "maps a backend refusal (%s) without disclosing internals",
  async (message, code, status) => {
    mocks.mutation.mockRejectedValue(
      Object.assign(new Error("Server Error"), { data: { code, message } }),
    );
    const response = await post(draft);
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("private backend context");
  },
);
