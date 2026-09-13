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
  mocks.action.mockRejectedValue(new Error("EVAL_JUDGE_BACKTEST_COOLDOWN"));
  const result = await post();
  expect(result.status).toBe(429);
  expect(result.headers.get("Retry-After")).toBe("60");
  mocks.action.mockRejectedValue(new Error("EVAL_RUN_NOT_TERMINAL"));
  expect((await post()).status).toBe(409);
});
