import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The run read `get_eval_run` uses carries the server variants the run
 * served, from its config snapshot, and nothing for a run that served none.
 */

const { validateGuestTokenMock, convexQueryMock } = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  convexQueryMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
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

import v1Routes from "../index.js";

const PROJECT_ID = "p1";
const RUN_ID = "run1xxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const VARIANT = {
  serverId: "vsrv1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
  variantId: "variant1xxxxxxxxxxxxxxxxxxxxxxxx",
  baseServerId: "base1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
  baseSurfaceHash: "b".repeat(64),
  editsHash: "e".repeat(64),
  contentHash: "c".repeat(64),
};

function runDoc(configSnapshot: Record<string, unknown>) {
  return {
    _id: RUN_ID,
    projectId: PROJECT_ID,
    suiteId: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
    runNumber: 1,
    status: "completed",
    result: "passed",
    createdAt: 1,
    configSnapshot,
  };
}

async function readRun(configSnapshot: Record<string, unknown>) {
  convexQueryMock.mockImplementation((name: string) =>
    Promise.resolve(name === "testSuites:getTestSuiteRun" ? runDoc(configSnapshot) : null),
  );
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  const response = await app.request(
    `/api/v1/projects/${PROJECT_ID}/eval-runs/${RUN_ID}`,
    { headers: { Authorization: "Bearer caller-bearer" } },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.stubEnv("CONVEX_URL", "https://example.convex.cloud");
  vi.stubEnv("CONVEX_HTTP_URL", "https://example.convex.site");
  validateGuestTokenMock.mockResolvedValue({ valid: false });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GET /projects/:projectId/eval-runs/:runId", () => {
  it("carries the variants the run served", async () => {
    const run = await readRun({ variants: [{ ...VARIANT, internal: "kept out" }] });
    expect(run.variants).toEqual([VARIANT]);
  });

  it("has no variants for a run that served none, or whose record doesn't read as one", async () => {
    expect(await readRun({})).not.toHaveProperty("variants");
    expect(await readRun({ variants: [{ serverId: 1 }] })).not.toHaveProperty("variants");
  });
});
