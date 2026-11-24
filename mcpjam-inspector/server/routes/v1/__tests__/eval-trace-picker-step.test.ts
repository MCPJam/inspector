import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ConvexError } from "convex/values";

/**
 * MCPJam's climb step reads traces through the public trace route. The route
 * hands the step's climb and generation to the backend, which refuses any
 * iteration that is not one of the climb's steering cases. These tests pin
 * the route's half: what it forwards, what it refuses on its own, and how the
 * backend's refusals read.
 */

const { validateGuestTokenMock, convexQueryMock, convexActionMock, fetchMock } = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  convexQueryMock: vi.fn(),
  convexActionMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(function () {
    return { setAuth: vi.fn(), query: convexQueryMock, mutation: vi.fn(), action: convexActionMock };
  }),
}));

import v1Routes from "../index.js";

const PROJECT_ID = "p1";
const RUN_ID = "run1xxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const ITERATION_ID = "iter1xxxxxxxxxxxxxxxxxxxxxxxxxxx";
const CLIMB_ID = "climb1xxxxxxxxxxxxxxxxxxxxxxxxxx";
const TRACE = { messages: [{ role: "user", content: "do the thing" }] };

function readTrace(headers: Record<string, string> = {}): Promise<Response> {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app.request(`/api/v1/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/iterations/${ITERATION_ID}/trace`, {
    method: "GET",
    headers: { Authorization: "Bearer caller", ...headers },
  });
}

const STEP = { "x-mcpjam-picker-step": "4", "x-mcpjam-picker-climb": CLIMB_ID };

beforeEach(() => {
  vi.stubEnv("CONVEX_URL", "https://example.convex.cloud");
  vi.stubEnv("CONVEX_HTTP_URL", "https://example.convex.site");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service");
  validateGuestTokenMock.mockResolvedValue({ valid: false });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  convexQueryMock.mockImplementation((name: string) => {
    if (name === "testSuites:getTestSuiteRun") return Promise.resolve({ _id: RUN_ID, projectId: PROJECT_ID });
    if (name === "testSuites:getTestIteration") return Promise.resolve({ _id: ITERATION_ID, suiteRunId: RUN_ID });
    return Promise.resolve(null);
  });
  convexActionMock.mockResolvedValue(TRACE);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("GET …/iterations/:iterationId/trace for MCPJam's climb step", () => {
  it("reads as the member when no step is named", async () => {
    const res = await readTrace();
    expect(res.status).toBe(200);
    expect(convexActionMock).toHaveBeenCalledWith("testSuites:getTestIterationBlob", { iterationId: ITERATION_ID });
  });

  it("hands the step's climb and generation to the backend", async () => {
    const res = await readTrace(STEP);
    expect(res.status).toBe(200);
    expect(convexActionMock).toHaveBeenCalledWith("testSuites:getTestIterationBlob", {
      iterationId: ITERATION_ID,
      pickerStep: { climbId: CLIMB_ID, generation: 4 },
    });
  });

  it.each([
    ["the generation alone", { "x-mcpjam-picker-step": "4" }],
    ["the climb alone", { "x-mcpjam-picker-climb": CLIMB_ID }],
    ["a generation that is not a number", { ...STEP, "x-mcpjam-picker-step": "four" }],
    ["a climb id of the wrong shape", { ...STEP, "x-mcpjam-picker-climb": "not an id" }],
  ])("refuses %s before reading, rather than reading as the member", async (_label, headers) => {
    const res = await readTrace(headers);
    expect(res.status).toBe(400);
    expect((await res.json()).details).toMatchObject({ reason: "PICKER_STEP_INCOMPLETE" });
    expect(convexActionMock).not.toHaveBeenCalled();
  });

  it("answers the backend's steering refusal in the fence's own words", async () => {
    convexActionMock.mockRejectedValue(
      new ConvexError({ code: "CLIMB_TRACE_NOT_STEERING", message: "The backend's sentence." }),
    );
    const res = await readTrace(STEP);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.message).toBe(
      "Only iterations of the climb's steering cases can be read. Take the run and iteration ids from the failed runs `get_climb` lists.",
    );
    expect(body.details).toMatchObject({ code: "CLIMB_TRACE_NOT_STEERING" });
  });

  it("passes on a lost lease, so the step stops", async () => {
    convexActionMock.mockRejectedValue(
      new ConvexError({ code: "LEASE_LOST", message: "This step's lease ran out. Stop this step and do not write to the climb." }),
    );
    const res = await readTrace(STEP);
    expect(res.status).toBe(409);
    expect((await res.json()).message).toMatch(/Stop this step/);
  });
});
