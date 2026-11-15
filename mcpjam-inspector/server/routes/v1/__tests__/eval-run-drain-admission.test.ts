/**
 * A draining server refuses to start eval runs, before anything is prepared or
 * connected, and still answers everything else.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const {
  drainState,
  validateGuestTokenMock,
  prepareEvalRunMock,
  createAuthorizedManagerMock,
  loadSuiteHostConfigMock,
  convexQueryMock,
} = vi.hoisted(() => ({
  drainState: { draining: false },
  validateGuestTokenMock: vi.fn(),
  prepareEvalRunMock: vi.fn(),
  createAuthorizedManagerMock: vi.fn(),
  loadSuiteHostConfigMock: vi.fn(),
  convexQueryMock: vi.fn(),
}));

vi.mock("../../../services/lifecycle/drain.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/lifecycle/drain.js")
  >("../../../services/lifecycle/drain.js");
  const real = actual.createDrainCoordinator();
  return {
    ...actual,
    serverDrain: { ...real, isDraining: () => drainState.draining },
  };
});

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("../../shared/evals.js", async () => {
  const actual = await vi.importActual<typeof import("../../shared/evals.js")>(
    "../../shared/evals.js",
  );
  return { ...actual, prepareEvalRun: prepareEvalRunMock };
});

vi.mock("../../web/auth.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../web/auth.js")>(
      "../../web/auth.js",
    );
  return { ...actual, createAuthorizedManager: createAuthorizedManagerMock };
});

vi.mock("../../../services/evals/compat-runtime.js", () => ({
  loadSuiteHostConfig: loadSuiteHostConfigMock,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(function () {
    return {
      setAuth: vi.fn(),
      query: convexQueryMock,
      mutation: vi.fn(),
      action: vi.fn(),
    };
  }),
}));

import { serverDrain } from "../../../services/lifecycle/drain.js";
import v1Evals from "../evals.js";
import v1Routes, { V1_EVAL_LAUNCH_ROUTES } from "../index.js";

const PROJECT_ID = "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SUITE_ID = "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx";
const RUN_ID = "run1xxxxxxxxxxxxxxxxxxxxxxxxxxxx";

/** Each launch route, as `send` takes it. */
const LAUNCH_PATHS = V1_EVAL_LAUNCH_ROUTES.map((route) =>
  route
    .replace("/projects/:projectId", "")
    .replace(":runId", RUN_ID)
    .replace(":experimentId", "exp1xxxxxxxxxxxxxxxxxxxxxxxxxxxx"),
);

/** The POST routes in `evals.ts` that do not call `launchEvalRun`. */
const NOT_LAUNCHES = [
  "/projects/:projectId/eval-suites",
  "/projects/:projectId/eval-suites/from-file",
  "/projects/:projectId/eval-runs/:runId/insights",
  "/projects/:projectId/eval-runs/:runId/judge",
  "/projects/:projectId/eval-runs/:runId/cancel",
  "/projects/:projectId/eval-runs/:runId/gate-waivers",
  "/projects/:projectId/eval-runs/:runId/description-experiments",
  "/projects/:projectId/eval-suites/:suiteId/environments",
  "/projects/:projectId/eval-suites/:suiteId/cases",
  "/projects/:projectId/eval-suites/:suiteId/cases/batch",
  "/projects/:projectId/eval-suites/:suiteId/cases/generate",
  "/projects/:projectId/eval-suites/:suiteId/cases/import",
  "/projects/:projectId/eval-suites/:suiteId/authoring/:jobId/commit",
];

const preparedRun = () => ({
  suiteId: SUITE_ID,
  runId: RUN_ID,
  caseUpsert: { committed: [], failed: [] },
  recorder: { finalize: vi.fn() },
  execute: vi.fn().mockResolvedValue(undefined),
});

function send(path: string, method = "POST", body?: unknown) {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app.request(`/api/v1/projects/${PROJECT_ID}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer tok",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  drainState.draining = false;
  process.env.CONVEX_URL = "https://convex.example.com";
  process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
  validateGuestTokenMock.mockResolvedValue({ valid: false });
  convexQueryMock.mockImplementation(async (fn: string) =>
    fn === "testSuites:getTestSuiteRun"
      ? {
          _id: RUN_ID,
          suiteId: SUITE_ID,
          projectId: PROJECT_ID,
          status: "running",
        }
      : { _id: SUITE_ID, projectId: PROJECT_ID, name: "Smoke" },
  );
  loadSuiteHostConfigMock.mockResolvedValue({});
  createAuthorizedManagerMock.mockResolvedValue({
    manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    oauthServerUrls: {},
    authenticatedUserId: null,
  });
  prepareEvalRunMock.mockImplementation(async () => preparedRun());
});

afterEach(() => {
  delete process.env.CONVEX_URL;
  delete process.env.CONVEX_HTTP_URL;
});

describe("v1 eval launches while the server drains", () => {
  it.each(LAUNCH_PATHS)(
    "refuses POST %s before preparing or connecting anything",
    async (path) => {
      drainState.draining = true;

      const res = await send(path, "POST", {
        suiteId: SUITE_ID,
        serverIds: ["s1"],
      });

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("5");
      expect(await res.json()).toMatchObject({
        code: "RATE_LIMITED",
        details: { reason: "SERVER_DRAINING" },
      });
      expect(createAuthorizedManagerMock).not.toHaveBeenCalled();
      expect(prepareEvalRunMock).not.toHaveBeenCalled();
    },
  );

  it("still answers reads", async () => {
    drainState.draining = true;

    const res = await send(`/eval-runs/${RUN_ID}`, "GET");
    expect(res.status).toBe(200);
  });

  it("lists every POST route in evals.ts as a launch or not", () => {
    // `launchEvalRun` is private to evals.ts, so a route added there fails
    // here until it is classified, and a new launch route cannot start runs on
    // a draining server unnoticed.
    const posts = new Set(
      v1Evals.routes
        .filter((route) => route.method === "POST")
        .map((route) => route.path),
    );
    expect([...posts].sort()).toEqual(
      [...V1_EVAL_LAUNCH_ROUTES, ...NOT_LAUNCHES].sort(),
    );
  });

  it("holds the drain for a launch still preparing when it begins", async () => {
    let prepared!: () => void;
    const preparing = new Promise<void>((resolve) => (prepared = resolve));
    prepareEvalRunMock.mockImplementation(async () => {
      await preparing;
      return preparedRun();
    });

    const launch = send("/eval-runs", "POST", {
      suiteId: SUITE_ID,
      serverIds: ["s1"],
    });
    await vi.waitFor(() => expect(prepareEvalRunMock).toHaveBeenCalled());
    drainState.draining = true;
    let finished = false;
    const drained = serverDrain.drain(60_000).finally(() => (finished = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(false);

    prepared();
    expect((await launch).status).toBe(202);
    await expect(drained).resolves.toMatchObject({
      drained: true,
      inFlightAtStart: { eval_run: 1 },
    });
  });

  it("holds the drain for the detached run after the launch answers", async () => {
    let finish!: () => void;
    const running = new Promise<void>((resolve) => (finish = resolve));
    prepareEvalRunMock.mockImplementation(async () => ({
      ...preparedRun(),
      execute: vi.fn(() => running),
    }));

    const res = await send("/eval-runs", "POST", {
      suiteId: SUITE_ID,
      serverIds: ["s1"],
    });
    expect(res.status).toBe(202);

    drainState.draining = true;
    await expect(serverDrain.drain(20)).resolves.toMatchObject({
      drained: false,
      remaining: { eval_run: 1 },
    });

    finish();
    await expect(serverDrain.drain(60_000)).resolves.toMatchObject({
      drained: true,
    });
  });

  it("starts runs as before when not draining", async () => {
    const res = await send("/eval-runs", "POST", {
      suiteId: SUITE_ID,
      serverIds: ["s1"],
    });

    expect(res.status).toBe(202);
    expect(prepareEvalRunMock).toHaveBeenCalledTimes(1);
  });
});
