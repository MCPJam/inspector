import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { NO_READ_ONLY_TOOLS_MESSAGE } from "../../../../shared/eval-generation-errors.js";
import { ConvexError } from "convex/values";
import { ErrorCode, WebRouteError } from "../../web/errors.js";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  fetch: vi.fn(),
  warn: vi.fn(),
  event: vi.fn(),
  selectEnvironment: vi.fn(),
}));
vi.mock("../../../services/evals/route-helpers.js", () => ({
  createConvexClient: () => ({
    query: mocks.query,
    mutation: mocks.mutation,
  }),
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
  selectSuiteEnvironmentId: mocks.selectEnvironment,
  fetchSuiteRunServerSelection: async () => ({
    serverIds: [],
    serverNames: [],
  }),
}));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "hosted-token",
}));
vi.mock("../../../utils/logger.js", () => ({ logger: { warn: mocks.warn } }));
vi.mock("../../../utils/request-logger.js", () => ({
  getRequestLogger: () => ({ event: mocks.event }),
}));
import { handleEvalAuthoring } from "../eval-authoring.js";
const app = new Hono();
app.post("/", (c) => handleEvalAuthoring(c, false));
app.post("/local", (c) => handleEvalAuthoring(c, true));
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
  mocks.selectEnvironment.mockReset();
  mocks.selectEnvironment.mockResolvedValue(undefined);
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
    expect(mocks.event).not.toHaveBeenCalled();
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
    expect(mocks.event).not.toHaveBeenCalled();
  });
  it("reports a hosted import missing its environment to Sentry", async () => {
    mocks.selectEnvironment.mockRejectedValue(
      new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "This suite has multiple environments; name the one to use.",
        { reason: "ENVIRONMENT_REQUIRED" },
      ),
    );
    const response = await post(JSON.stringify(start));
    expect(response.status).toBe(400);
    expect(mocks.event).toHaveBeenCalledTimes(1);
    expect(mocks.event).toHaveBeenCalledWith(
      "eval.import.environment_selection.failed",
      { projectId: "p", suiteId: "s", reason: "ENVIRONMENT_REQUIRED" },
      { sentry: true },
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { local: true, source: "markdown", reason: "ENVIRONMENT_REQUIRED" },
    { local: false, source: "generation", reason: "ENVIRONMENT_REQUIRED" },
    { local: false, source: "markdown", reason: "ENVIRONMENT_NOT_ATTACHED" },
  ])(
    "does not page for other environment failures: %j",
    async ({ local, source, reason }) => {
      mocks.selectEnvironment.mockRejectedValue(
        new WebRouteError(400, ErrorCode.VALIDATION_ERROR, "Environment error", {
          reason,
        }),
      );
      const response = await app.request(local ? "/local" : "/", {
        method: "POST",
        body: JSON.stringify({
          ...start,
          ...(local ? { convexAuthToken: "local-token" } : {}),
          input: { ...start.input, source },
        }),
      });
      expect(response.status).toBe(400);
      expect(mocks.event).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );
});

it("reports no read-only tools as a validation error", async () => {
  const response = await post(JSON.stringify({ ...start, input: { ...start.input, options: { toolCoverage: "read-only" } } }));
  expect(response.status).toBe(400);
  expect(await response.text()).toContain(NO_READ_ONLY_TOOLS_MESSAGE);
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("answers a stale draft's CONFLICT refusal as a 409 with its message", async () => {
  // The backend refuses a stale accept with a ConvexError; mapping it with
  // the bare runtime mapper turned it into a 500 "Server Error".
  mocks.mutation.mockRejectedValue(
    new ConvexError({
      code: "CONFLICT",
      message: "Draft changed. Review it again.",
    }),
  );
  const response = await post(
    JSON.stringify({
      operation: "accept",
      draftId: "d",
      revision: 0,
      acceptedAdditionIds: [],
    }),
  );
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("Draft changed. Review it again.");
});
