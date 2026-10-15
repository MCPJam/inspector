/**
 * A hosted harness single-case run boots its own disposable box, so it owes
 * every rule an unattended harness run obeys, and is refused for what that
 * box cannot carry. Both are decided in `prepareSingleCaseExecution`, before
 * any commit, so a refusal writes nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());
const actionMock = vi.hoisted(() => vi.fn());

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class MockConvexHttpClient {
    setAuth = vi.fn();
    query = (...args: unknown[]) => queryMock(...args);
    mutation = vi.fn(async () => null);
    action = (...args: unknown[]) => actionMock(...args);
  },
}));

// Hosted venue: a local harness has its own readiness checks.
vi.mock("../../../utils/harness/local/run-resources.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../utils/harness/local/run-resources.js")
  >()),
  shouldUseLocalHarness: vi.fn(async () => false),
}));

// A replica that can advertise the browser, so a declared one is refused for
// the box rather than for the deployment.
vi.mock("../../../utils/computers/runtime-config.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../utils/computers/runtime-config.js")
  >()),
  hostedBrowserAdvertisable: () => true,
}));

import { prepareSingleCaseExecution } from "../evals";

const ENV = {
  CONVEX_URL: "https://example.convex.cloud",
  CONVEX_HTTP_URL: "https://example.convex.site",
  // A server on which the harness runtime IS available, so every refusal below
  // is attributable to the configuration under test.
  INSPECTOR_SERVICE_TOKEN: "test-svc-token",
  COMPUTERS_TERMINAL_TOKEN_SECRET: "terminal-secret-16+",
  E2B_API_KEY: "e2b-test",
  MCPJAM_HARNESS_BROKER_DELIVERY: "true",
};

const clientManager = {
  listServers: vi.fn(() => ["srv-1"]),
  hasServer: vi.fn((id: string) => id === "srv-1"),
  getToolsForAiSdk: vi.fn(async () => ({})),
};

function request(
  hostConfig: Record<string, unknown>,
  model = "anthropic/claude-haiku-4.5",
) {
  return {
    testCaseId: "case-1",
    projectId: "project-1",
    model,
    provider: "anthropic",
    serverIds: ["srv-1"],
    convexAuthToken: "token",
    hostConfigOverride: { harness: "claude-code", ...hostConfig },
  } as Parameters<typeof prepareSingleCaseExecution>[1];
}

describe("prepareSingleCaseExecution — hosted harness admission", () => {
  const saved: Record<string, string | undefined> = {};
  let testCase: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const [key, value] of Object.entries(ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    testCase = {
      _id: "case-1",
      title: "Refund",
      query: "Refund the last charge",
      evalTestSuiteId: "suite-1",
      projectId: "project-1",
    };
    queryMock.mockImplementation(async (name: string) =>
      name === "testSuites:getTestCase" ? testCase : null,
    );
    actionMock.mockResolvedValue(null);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function refusal(
    req: Parameters<typeof prepareSingleCaseExecution>[1],
  ) {
    const error = await prepareSingleCaseExecution(
      clientManager as never,
      req,
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ status: 400 });
    // Refused before the commit: nothing was written.
    expect(actionMock).not.toHaveBeenCalled();
    return error as { message: string; details?: Record<string, unknown> };
  }

  it("refuses an approval host: nobody can answer one in an eval", async () => {
    const error = await refusal(request({ requireToolApproval: true }));
    expect(error.details).toMatchObject({ reason: "HARNESS_UNAVAILABLE" });
    expect(error.message).toContain("unattended run");
  });

  it("refuses a model the harness has not verified", async () => {
    const error = await refusal(request({}, "anthropic/claude-fable-5"));
    expect(error.details).toMatchObject({ reason: "HARNESS_UNAVAILABLE" });
    expect(error.message).toMatch(/^not verified for claude-code /);
  });

  it("refuses a declared browser: the single-case box is only a terminal", async () => {
    const error = await refusal(
      request({
        builtInToolIds: ["browser"],
        browserToolPolicy: { mode: "allow_all" },
      }),
    );
    expect(error.details).toMatchObject({
      reason: "EVAL_EXECUTION_UNAVAILABLE",
    });
    expect(error.message).toContain("browser tool policy");
  });

  it("refuses a case with attachments: they are seeded through a suite run", async () => {
    testCase.attachments = [
      { name: "a.csv", storageId: "st-1", contentHash: "h", size: 1 },
    ];
    const error = await refusal(request({}));
    expect(error.details).toMatchObject({
      reason: "EVAL_EXECUTION_UNAVAILABLE",
    });
    expect(error.message).toContain("attached files");
  });

  it("does not refuse an emulated host for its attachments", async () => {
    // The refusal is about the harness box; an emulated run boots none.
    testCase.attachments = [
      { name: "a.csv", storageId: "st-1", contentHash: "h", size: 1 },
    ];
    const error = await prepareSingleCaseExecution(clientManager as never, {
      ...request({}),
      hostConfigOverride: { hostStyle: "claude" },
    }).then(
      () => undefined,
      (caught: unknown) => caught as { details?: Record<string, unknown> },
    );
    expect(error?.details?.reason).not.toBe("EVAL_EXECUTION_UNAVAILABLE");
  });
});
