import { beforeEach, it, expect, vi } from "vitest";
import { Hono } from "hono";
const mocks = vi.hoisted(() => ({ query: vi.fn(), action: vi.fn() }));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query(...args: unknown[]) {
      return mocks.query(...args);
    }
    action(...args: unknown[]) {
      return mocks.action(...args);
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
const url = "/api/v1/projects/project/eval-runs/run/backtest";
const payload = { assertions: { mode: "replace", list: [] } };
const post = (body = payload) =>
  app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.stubEnv("CONVEX_URL", "https://convex.test");
  mocks.query
    .mockReset()
    .mockResolvedValue({ projectId: "project", suiteId: "suite" });
  mocks.action.mockReset().mockResolvedValue({
    schemaVersion: 1,
    runId: "run",
    suiteId: "suite",
    sourceHash: "source",
    reservationId: "r",
    isDone: true,
    iterations: [],
  });
});
it("validates before reserving evidence", async () => {
  expect(
    (await post({ assertions: { mode: "invalid", list: [] } } as any)).status,
  ).toBe(400);
  expect(mocks.action).not.toHaveBeenCalled();
});
it("binds run to the path project", async () => {
  mocks.query.mockResolvedValue({ projectId: "other", suiteId: "suite" });
  expect((await post()).status).toBe(404);
  expect(mocks.action).not.toHaveBeenCalled();
});
it("reserves bounded evidence without verdict mutation", async () => {
  expect((await post()).status).toBe(200);
  expect(mocks.action).toHaveBeenCalledWith(
    "goalCompletionAction:readBacktestEvidence",
    { suiteId: "suite", runId: "run", pageSize: 10 },
  );
});
it("returns cooldown/nonterminal as errors", async () => {
  mocks.action.mockRejectedValue(new Error("EVAL_BACKTEST_COOLDOWN"));
  const result = await post();
  expect(result.status).toBe(429);
  expect(result.headers.get("Retry-After")).toBe("60");
  mocks.action.mockRejectedValue(new Error("EVAL_RUN_NOT_TERMINAL"));
  expect((await post()).status).toBe(409);
});

it.each([
  ["CONFLICT", 409],
  ["VALIDATION_ERROR", 400],
  ["NOT_FOUND", 404],
])(
  "maps typed backend %s without disclosing internals",
  async (code, status) => {
    mocks.action.mockRejectedValue(
      Object.assign(new Error("Server Error"), {
        data: { code, message: "private backend context" },
      }),
    );
    const response = await post();
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("private backend context");
  },
);
it("maps typed assertion cooldown separately from judge previews", async () => {
  mocks.action.mockRejectedValue(
    Object.assign(new Error("Server Error"), {
      data: { code: "EVAL_BACKTEST_COOLDOWN" },
    }),
  );
  expect((await post()).status).toBe(429);
});

it("forwards a judge rubric and continuation without dropping instructions", async () => {
  const continuation = {
    cursor: 1,
    sourceHash: "a".repeat(64),
    reservationId: "reservation",
  };
  const rubric = { instructions: "Check every tool result" };
  const response = await app.request(
    url.replace("/backtest", "/judge/backtest"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rubric, continuation }),
    },
  );
  expect(response.status).toBe(200);
  expect(mocks.action).toHaveBeenCalledWith(
    "goalCompletionAction:requestJudgeBacktest",
    {
      suiteId: "suite",
      runId: "run",
      judgeRubricDraft: rubric,
      ...continuation,
    },
  );
});
it("refuses a judge preview for another project before spending", async () => {
  mocks.query.mockResolvedValue({ projectId: "other", suiteId: "suite" });
  const response = await app.request(
    url.replace("/backtest", "/judge/backtest"),
    { method: "POST", body: JSON.stringify({ rubric: null }) },
  );
  expect(response.status).toBe(404);
  expect(mocks.action).not.toHaveBeenCalled();
});
