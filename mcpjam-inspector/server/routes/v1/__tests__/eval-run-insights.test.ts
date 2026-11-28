/**
 * Eval run insights routes: request (findings mode), cancel, and the findings
 * build. Each resolves the run and asserts its project before writing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { Hono } from "hono";

beforeEach(() => {
  vi.stubEnv("CONVEX_URL", "https://convex.test");
  vi.clearAllMocks();
});

const queryMock = vi.fn();
const mutationMock = vi.fn();

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query(...args: unknown[]) {
      return queryMock(...args);
    }
    mutation(...args: unknown[]) {
      return mutationMock(...args);
    }
  },
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "convex-jwt",
  getConvexBearerThunkForRequest: async () => async () => "convex-jwt",
}));

import evalRunInsights from "../eval-run-insights.js";
import { v1OnError } from "../envelope.js";
import { isGuestAllowedV1Request } from "../guest-allowed-paths.js";

const PROJECT = "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx";
const RUN = "run1xxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const INSIGHTS = `/api/v1/projects/${PROJECT}/eval-runs/${RUN}/insights`;
const BUILD = `/api/v1/projects/${PROJECT}/eval-runs/${RUN}/findings/build`;

const RUN_ROW = {
  _id: RUN,
  suiteId: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
  projectId: PROJECT,
  status: "completed",
};

function app() {
  const root = new Hono();
  root.onError(v1OnError);
  root.route("/api/v1", evalRunInsights);
  return root;
}

function runIs(row: unknown) {
  queryMock.mockImplementation((name: string) =>
    String(name) === "testSuites:getTestSuiteRun"
      ? Promise.resolve(row)
      : Promise.reject(new Error(`unexpected query ${String(name)}`)),
  );
}

function post(path: string, body?: string) {
  return app().request(path, {
    method: "POST",
    ...(body === undefined
      ? {}
      : { body, headers: { "content-type": "application/json" } }),
  });
}

describe("POST …/insights", () => {
  it("starts the findings analysis and answers a pending receipt", async () => {
    runIs(RUN_ROW);
    mutationMock.mockResolvedValue(null);
    const res = await post(INSIGHTS, JSON.stringify({ force: true }));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      runId: RUN,
      projectId: PROJECT,
      status: "pending",
    });
    expect(mutationMock).toHaveBeenCalledWith(
      "serverQuality:requestServerQuality",
      { suiteRunId: RUN, mode: "findings", force: true },
    );
  });

  it("accepts a bodyless POST and force: false without forwarding force", async () => {
    runIs(RUN_ROW);
    mutationMock.mockResolvedValue(null);
    expect((await post(INSIGHTS)).status).toBe(202);
    expect(
      (await post(INSIGHTS, JSON.stringify({ force: false }))).status,
    ).toBe(202);
    for (const call of mutationMock.mock.calls) {
      expect(call[1]).toEqual({ suiteRunId: RUN, mode: "findings" });
    }
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["a truthy non-boolean force", JSON.stringify({ force: "false" })],
    ["null force", JSON.stringify({ force: null })],
    ["a whitespace-only body", "   "],
    ["an unknown field", JSON.stringify({ mode: "legacy" })],
  ])("400s on %s before requesting anything", async (_label, body) => {
    runIs(RUN_ROW);
    const res = await post(INSIGHTS, body);
    expect(res.status).toBe(400);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("404s across projects before requesting anything", async () => {
    runIs({ ...RUN_ROW, projectId: "proj2xxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    expect((await post(INSIGHTS)).status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("409s when the run has no findings to explain yet", async () => {
    runIs(RUN_ROW);
    mutationMock.mockRejectedValue(
      new ConvexError({
        code: "CONFLICT",
        message:
          "Findings have not been built for this run yet. Build findings first, then add an AI explanation.",
      }),
    );
    const res = await post(INSIGHTS);
    expect(res.status).toBe(409);
  });
});

describe("DELETE …/insights", () => {
  it("cancels the running analysis", async () => {
    runIs(RUN_ROW);
    mutationMock.mockResolvedValue(null);
    const res = await app().request(INSIGHTS, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      runId: RUN,
      projectId: PROJECT,
      canceled: true,
    });
    expect(mutationMock).toHaveBeenCalledWith(
      "serverQuality:cancelServerQuality",
      { suiteRunId: RUN },
    );
  });

  it("409s when no analysis is running", async () => {
    runIs(RUN_ROW);
    mutationMock.mockRejectedValue(
      new ConvexError({
        code: "CONFLICT",
        message:
          "No analysis is running for this eval run, so there is nothing to cancel.",
      }),
    );
    const res = await app().request(INSIGHTS, { method: "DELETE" });
    expect(res.status).toBe(409);
  });

  it("404s across projects before cancelling anything", async () => {
    runIs({ ...RUN_ROW, projectId: "proj2xxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    const res = await app().request(INSIGHTS, { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });
});

describe("POST …/findings/build", () => {
  it("starts a build and answers a pending receipt", async () => {
    runIs(RUN_ROW);
    mutationMock.mockResolvedValue({ jobId: "job-1" });
    const res = await post(BUILD, JSON.stringify({ force: true }));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      runId: RUN,
      projectId: PROJECT,
      status: "pending",
    });
    expect(mutationMock).toHaveBeenCalledWith(
      "evalFindings:requestEvalFindingsBuild",
      { suiteRunId: RUN, force: true },
    );
  });

  it("400s on an unknown field", async () => {
    runIs(RUN_ROW);
    const res = await post(BUILD, JSON.stringify({ rebuild: true }));
    expect(res.status).toBe(400);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("409s when findings exist and force is absent", async () => {
    runIs(RUN_ROW);
    mutationMock.mockRejectedValue(
      new ConvexError({
        code: "CONFLICT",
        message:
          "Findings have already been built for this run. Pass force: true to rebuild.",
      }),
    );
    expect((await post(BUILD)).status).toBe(409);
  });

  it("404s across projects before building anything", async () => {
    runIs({ ...RUN_ROW, projectId: "proj2xxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    expect((await post(BUILD)).status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });
});

describe("guest boundary", () => {
  it.each([
    ["POST", INSIGHTS],
    ["DELETE", INSIGHTS],
    ["POST", BUILD],
  ])("keeps %s %s guest-closed", (method, path) => {
    expect(isGuestAllowedV1Request(method, path)).toBe(false);
  });
});
