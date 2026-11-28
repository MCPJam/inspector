/**
 * A run's own setup and cleanup script results (EFTW-90) on the v1 run read:
 * a whitelist of known keys, omitted when the run has none.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query(...args: unknown[]) {
      return queryMock(...args);
    }
    mutation() {
      return Promise.reject(new Error("the run read writes nothing"));
    }
    action() {
      return Promise.reject(new Error("the run read calls no action"));
    }
  },
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "convex-jwt",
  getConvexBearerThunkForRequest: async () => async () => "convex-jwt",
}));

import evals from "../evals.js";
import { v1OnError } from "../envelope.js";
import { toRunScriptResultsProjection } from "../eval-code-grading-projection.js";

const PROJECT = "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx";
const RUN = "run1xxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const RUN_ROW = {
  _id: RUN,
  suiteId: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
  projectId: PROJECT,
  status: "completed",
  result: "passed",
  source: "api",
  createdAt: 1,
};

const app = new Hono();
app.onError(v1OnError);
app.route("/api/v1", evals);

async function readRun(run: Record<string, unknown>) {
  queryMock.mockImplementation((name: string) => {
    if (String(name).endsWith(":getTestSuiteRun")) return Promise.resolve(run);
    // No insights envelope: the field is omitted, the read still answers.
    return Promise.reject(new Error(`unexpected query ${String(name)}`));
  });
  const response = await app.request(
    `/api/v1/projects/${PROJECT}/eval-runs/${RUN}`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.stubEnv("CONVEX_URL", "https://convex.test");
  queryMock.mockReset();
});

describe("GET /eval-runs/:runId — scriptResults", () => {
  it("projects the run's setup and cleanup results, known keys only", async () => {
    const body = await readRun({
      ...RUN_ROW,
      scriptResults: {
        runSetup: {
          status: "passed",
          exitCode: 0,
          output: "seeded 3 invoices\n",
          durationMs: 1200,
          internalNote: "not for callers",
        },
        runCleanup: {
          status: "timeout",
          output: "",
          error: "Stopped at its time limit.",
        },
        somethingElse: { status: "passed", output: "" },
      },
    });
    expect(body.scriptResults).toEqual({
      runSetup: {
        status: "passed",
        exitCode: 0,
        output: "seeded 3 invoices\n",
        durationMs: 1200,
      },
      runCleanup: {
        status: "timeout",
        output: "",
        error: "Stopped at its time limit.",
      },
    });
  });

  it("omits the field for a run without script results", async () => {
    expect(await readRun(RUN_ROW)).not.toHaveProperty("scriptResults");
    expect(
      await readRun({
        ...RUN_ROW,
        scriptResults: { runSetup: { exitCode: 1 } },
      }),
    ).not.toHaveProperty("scriptResults");
  });
});

describe("toRunScriptResultsProjection", () => {
  it("keeps one script without inventing the other, and refuses non-objects", () => {
    expect(
      toRunScriptResultsProjection({
        runCleanup: { status: "failed", exitCode: 2 },
      }),
    ).toEqual({
      scriptResults: {
        runCleanup: { status: "failed", output: "", exitCode: 2 },
      },
    });
    expect(toRunScriptResultsProjection(undefined)).toEqual({});
    expect(toRunScriptResultsProjection(["runSetup"])).toEqual({});
    expect(toRunScriptResultsProjection({ runSetup: "passed" })).toEqual({});
  });
});
