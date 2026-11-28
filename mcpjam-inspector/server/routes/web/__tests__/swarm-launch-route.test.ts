import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode, WebRouteError } from "../errors.js";

const mocks = vi.hoisted(() => ({
  launchSwarmRun: vi.fn(),
  resumeSwarmRun: vi.fn(),
  backgroundBearer: vi.fn(),
  draining: false,
}));

vi.mock(
  "../../../services/swarm-launch/launch-swarm-run.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../services/swarm-launch/launch-swarm-run.js")
    >()),
    launchSwarmRun: (...args: unknown[]) => mocks.launchSwarmRun(...args),
    resumeSwarmRun: (...args: unknown[]) => mocks.resumeSwarmRun(...args),
  }),
);

vi.mock("../../../utils/v1-convex-token.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../utils/v1-convex-token.js")
  >()),
  getBackgroundRunBearerForRequest: (...args: unknown[]) =>
    mocks.backgroundBearer(...args),
}));

vi.mock("../../../services/xaa-mint.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/xaa-mint.js")>()),
  resolveXaaIssuer: () => "https://issuer.test/api/web/xaa",
}));

vi.mock("../../../services/lifecycle/drain.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../services/lifecycle/drain.js")
    >();
  const real = actual.createDrainCoordinator();
  return {
    ...actual,
    serverDrain: { ...real, isDraining: () => mocks.draining },
  };
});

import { createWebTestApp, expectJson, postJson } from "./helpers/test-app.js";

const PATH = "/api/web/swarm/swarm-runs";
const runBearer = async () => "run-bearer";

const launched = {
  status: 202,
  body: {
    swarmRunId: "sr_new",
    launch: {
      swarmRunId: "sr_new",
      swarmId: null,
      sourceSwarmRunId: "sr_source",
      state: "launching",
      createdAt: 1,
      goals: [],
    },
  },
};

describe("POST /api/web/swarm/swarm-runs", () => {
  const { app, token } = createWebTestApp();

  beforeEach(() => {
    mocks.draining = false;
    mocks.launchSwarmRun.mockReset().mockResolvedValue(launched);
    mocks.resumeSwarmRun.mockReset().mockResolvedValue(launched);
    mocks.backgroundBearer.mockReset().mockResolvedValue(runBearer);
  });

  it("hands the launch to the module with the bearers, issuer and caller resolved in the request", async () => {
    const response = await postJson(
      app,
      PATH,
      { projectId: "proj-1", swarmRun: "sr_source", idempotencyKey: "key-1" },
      token,
    );
    const { status, data } = await expectJson(response);
    expect(status).toBe(202);
    expect(data).toEqual(launched.body);
    expect(mocks.backgroundBearer).toHaveBeenCalledWith(
      expect.anything(),
      "proj-1",
    );
    const [input, deps] = mocks.launchSwarmRun.mock.calls[0]!;
    expect(input).toEqual({
      projectId: "proj-1",
      request: { swarmRun: "sr_source", idempotencyKey: "key-1" },
    });
    expect(deps).toMatchObject({
      bearerToken: token,
      getRunBearer: runBearer,
      xaaIssuer: "https://issuer.test/api/web/xaa",
      callerContext: expect.any(Object),
    });
  });

  it.each([
    ["no project", { swarmRun: "sr_1", idempotencyKey: "k" }],
    ["no idempotency key", { projectId: "p", swarmRun: "sr_1" }],
    ["nothing to launch", { projectId: "p", idempotencyKey: "k" }],
    [
      "two things to launch",
      { projectId: "p", swarmRun: "sr_1", swarm: "s", idempotencyKey: "k" },
    ],
    [
      "goalIds with goals",
      {
        projectId: "p",
        goals: [{ goalId: "g1" }],
        goalIds: ["g1"],
        idempotencyKey: "k",
      },
    ],
    [
      "iterations out of range",
      { projectId: "p", swarmRun: "sr_1", iterations: 6, idempotencyKey: "k" },
    ],
    [
      "a field it does not take",
      { projectId: "p", swarmRun: "sr_1", dryRun: true, idempotencyKey: "k" },
    ],
  ])("refuses a body with %s, launching nothing", async (_name, body) => {
    const response = await postJson(app, PATH, body, token);
    const { status, data } = await expectJson<{ code: string }>(response);
    expect(status).toBe(400);
    expect(data.code).toBe("VALIDATION_ERROR");
    expect(mocks.launchSwarmRun).not.toHaveBeenCalled();
  });

  it("answers a refusal in the web envelope, with the launch record and Retry-After", async () => {
    mocks.launchSwarmRun.mockResolvedValue({
      status: 429,
      body: {
        error: {
          code: ErrorCode.RATE_LIMITED,
          message: "Your plan's daily swarm runs are used up.",
          details: { code: "billing_limit_reached" },
        },
        launch: { ...launched.body.launch, state: "stopped" },
      },
      headers: { "Retry-After": "3600" },
    });
    const response = await postJson(
      app,
      PATH,
      { projectId: "proj-1", swarmRun: "sr_source", idempotencyKey: "key-1" },
      token,
    );
    expect(response.headers.get("Retry-After")).toBe("3600");
    const { status, data } = await expectJson(response);
    expect(status).toBe(429);
    expect(data).toMatchObject({
      code: "RATE_LIMITED",
      message: "Your plan's daily swarm runs are used up.",
      details: { code: "billing_limit_reached" },
      launch: { swarmRunId: "sr_new", state: "stopped" },
    });
  });

  it("refuses to start a launch while the server drains", async () => {
    mocks.draining = true;
    const response = await postJson(
      app,
      PATH,
      { projectId: "proj-1", swarmRun: "sr_source", idempotencyKey: "key-1" },
      token,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await response.json()).toMatchObject({
      code: "RATE_LIMITED",
      details: { reason: "SERVER_DRAINING" },
    });
    expect(mocks.launchSwarmRun).not.toHaveBeenCalled();
  });

  it("answers a project it cannot delegate for before launching anything", async () => {
    mocks.backgroundBearer.mockRejectedValue(
      new WebRouteError(
        403,
        ErrorCode.FORBIDDEN,
        "Cannot authorize background execution for this project",
      ),
    );
    const response = await postJson(
      app,
      PATH,
      { projectId: "proj-x", swarmRun: "sr_source", idempotencyKey: "key-1" },
      token,
    );
    expect(response.status).toBe(403);
    expect(mocks.launchSwarmRun).not.toHaveBeenCalled();
  });

  describe("resume", () => {
    const RESUME = "/api/web/swarm/swarm-runs/sr_new/resume";

    it("resumes the swarm run named in the path, with the same request plumbing as a launch", async () => {
      const response = await postJson(
        app,
        RESUME,
        { projectId: "proj-1" },
        token,
      );
      const { status, data } = await expectJson(response);
      expect(status).toBe(202);
      expect(data).toEqual(launched.body);
      const [input, deps] = mocks.resumeSwarmRun.mock.calls[0]!;
      expect(input).toEqual({ projectId: "proj-1", swarmRunId: "sr_new" });
      expect(deps).toMatchObject({
        bearerToken: token,
        getRunBearer: runBearer,
        xaaIssuer: "https://issuer.test/api/web/xaa",
      });
    });

    it.each([
      ["no project", {}],
      ["a field it does not take", { projectId: "p", idempotencyKey: "k" }],
    ])("refuses a body with %s", async (_name, body) => {
      const response = await postJson(app, RESUME, body, token);
      expect(response.status).toBe(400);
      expect(mocks.resumeSwarmRun).not.toHaveBeenCalled();
    });

    it("refuses to resume while the server drains", async () => {
      mocks.draining = true;
      const response = await postJson(
        app,
        RESUME,
        { projectId: "proj-1" },
        token,
      );
      expect(response.status).toBe(429);
      expect(mocks.resumeSwarmRun).not.toHaveBeenCalled();
    });
  });
});
