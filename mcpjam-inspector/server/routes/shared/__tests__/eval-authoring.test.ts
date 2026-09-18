import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { NO_READ_ONLY_TOOLS_MESSAGE } from "../../../../shared/eval-generation-errors.js";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  fetch: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("../../../services/evals/route-helpers.js", () => ({
  createConvexClient: () => ({ query: mocks.query }),
  requireConvexHttpUrl: () => "https://backend.test",
  captureToolSnapshotForEvalAuthoring: async () => ({ toolSnapshot: { servers: [] } }),
}));
vi.mock("../../web/auth.js", () => ({
  callerContextFromHono: () => ({}),
  createAuthorizedManager: async () => ({
    manager: { disconnectAllServers: async () => {} },
  }),
}));
vi.mock("../../v1/evals.js", () => ({
  selectSuiteEnvironmentId: async () => undefined,
  fetchSuiteRunServerSelection: async () => ({
    serverIds: [],
    serverNames: [],
  }),
}));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "hosted-token",
}));
vi.mock("../../../utils/logger.js", () => ({ logger: { warn: mocks.warn } }));
import { handleEvalAuthoring } from "../eval-authoring.js";
const app = new Hono();
app.post("/", (c) => handleEvalAuthoring(c, false));
const start = {
  operation: "start",
  input: {
    projectId: "p",
    suiteId: "s",
    requestKey: "key",
    source: "markdown",
    markdown: "case",
  },
};
const post = (body: string) => app.request("/", { method: "POST", body });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.query.mockResolvedValue({});
});
describe("authoring adapter", () => {
  it.each([
    "{",
    "null",
    "[]",
    JSON.stringify({ operation: "invalid" }),
    "x".repeat(750001),
  ])("rejects invalid input without upstream work %#", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each(["", "<html>private upstream body</html>"])(
    "returns stable JSON for invalid upstream body %#",
    async (body) => {
      mocks.fetch.mockResolvedValue(
        new Response(body, {
          status: 503,
          headers: { "content-type": "text/html" },
        }),
      );
      const response = await post(JSON.stringify(start));
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        code: "authoring_upstream_invalid_response",
        upstreamStatus: 503,
      });
      expect(mocks.warn).toHaveBeenCalledWith(expect.any(String), {
        status: 503,
        contentType: "text/html",
      });
    },
  );
  it("preserves valid upstream JSON and status", async () => {
    mocks.fetch.mockResolvedValue(
      Response.json({ jobId: "job" }, { status: 202 }),
    );
    const response = await post(JSON.stringify(start));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ jobId: "job" });
  });
});

it("reports no read-only tools as a validation error", async () => {
  const response = await post(JSON.stringify({ ...start, input: { ...start.input, options: { toolCoverage: "read-only" } } }));
  expect(response.status).toBe(400);
  expect(await response.text()).toContain(NO_READ_ONLY_TOOLS_MESSAGE);
  expect(mocks.fetch).not.toHaveBeenCalled();
});
