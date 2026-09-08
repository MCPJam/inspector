/**
 * `MCPJAM_SCHEDULED_EVALS_WRITE_ENABLED` — the deployment switch over ENABLING
 * a suite schedule, enforced on the write path.
 *
 * The PostHog flag `scheduled-evals-enabled` only hides the UI. This route is
 * what the SDK client, the `set_eval_suite_schedule` MCP tool, `mcpjam cloud
 * eval schedule` and proposal execution all self-dispatch through, so the one
 * guard here is what makes "not yet tested" true for every writer.
 *
 * Two properties carry the weight:
 *
 *   1. IT ANSWERS 404, NOT 403 — the local-harness kill switch's rule: an
 *      operator who turned the feature off should not have the surface
 *      advertise that it exists.
 *   2. DISABLING IS UNGATED. A gate that strands a schedule already firing,
 *      with no way to switch it off, is the worse failure — the same call the
 *      `trace-destinations` flag makes for delete/pause/disable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const configState = vi.hoisted(() => ({ scheduledEvalsWrite: false }));
// Spread over the real module: the v1 route graph reads a dozen other config
// exports, and a bare factory would have to restate every one of them.
vi.mock("../../../config.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get SCHEDULED_EVALS_WRITE_ENABLED() {
    return configState.scheduledEvalsWrite;
  },
}));

const { validateGuestTokenMock, convexQueryMock, convexMutationMock } =
  vi.hoisted(() => ({
    validateGuestTokenMock: vi.fn(),
    convexQueryMock: vi.fn(),
    convexMutationMock: vi.fn(),
  }));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
    mutation: convexMutationMock,
    action: vi.fn(),
  })),
}));

import v1Routes from "../index.js";

const SUITE_DOC = {
  _id: "suite_1",
  projectId: "p1",
  createdBy: "user_1",
  workspaceId: "ws_1",
  name: "My Suite",
  description: "desc",
  environment: { servers: [] },
  // A saved interval, so an enable needs no `intervalMinutes` of its own and
  // a 400 from the interval check can never be mistaken for the switch's 404.
  schedule: { enabled: false, intervalMinutes: 60 },
  createdAt: 1,
  updatedAt: 2,
};

function patchSchedule(body: Record<string, unknown>): Promise<Response> {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return Promise.resolve(
    app.request("/api/v1/projects/p1/eval-suites/suite_1/schedule", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok",
      },
      body: JSON.stringify(body),
    }),
  );
}

/** Did the route reach the backend at all? */
function scheduleMutation() {
  return convexMutationMock.mock.calls.find(
    (c) => c[0] === "testSuites:setSuiteSchedule",
  );
}

describe("scheduled-eval writes — deployment switch", () => {
  const originalEnv = {
    CONVEX_URL: process.env.CONVEX_URL,
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    configState.scheduledEvalsWrite = false;
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestSuite"
        ? Promise.resolve(SUITE_DOC)
        : Promise.resolve(null),
    );
    convexMutationMock.mockResolvedValue(null);
  });

  afterEach(() => {
    process.env.CONVEX_URL = originalEnv.CONVEX_URL;
    process.env.CONVEX_HTTP_URL = originalEnv.CONVEX_HTTP_URL;
  });

  it("404s an enable while the switch is off, without touching the backend", async () => {
    const res = await patchSchedule({ enabled: true, intervalMinutes: 60 });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code?: string }).code).toBe("NOT_FOUND");
    expect(scheduleMutation()).toBeUndefined();
  });

  it("still lets a schedule be DISABLED while the switch is off", async () => {
    // The whole reason the guard reads `body.enabled`: hiding the UI does not
    // stop a schedule that is already firing, so switching one off has to keep
    // working on a deployment where enabling does not.
    const res = await patchSchedule({ enabled: false });
    expect(res.status).toBe(200);
    expect(scheduleMutation()?.[1]).toMatchObject({
      suiteId: "suite_1",
      enabled: false,
    });
  });

  it("allows an enable once the switch is on", async () => {
    configState.scheduledEvalsWrite = true;
    const res = await patchSchedule({ enabled: true, intervalMinutes: 60 });
    expect(res.status).toBe(200);
    expect(scheduleMutation()?.[1]).toMatchObject({
      suiteId: "suite_1",
      enabled: true,
      intervalMinutes: 60,
    });
  });

  // The 404 is decided from the BODY, before the suite is read — so a caller
  // cannot use it to learn whether a given suite id exists.
  it("404s an enable for an unknown suite the same way", async () => {
    convexQueryMock.mockResolvedValue(null);
    const res = await patchSchedule({ enabled: true, intervalMinutes: 60 });
    expect(res.status).toBe(404);
    expect(convexQueryMock).not.toHaveBeenCalled();
  });
});
