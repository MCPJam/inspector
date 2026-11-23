/**
 * A web client's suite run freezes its web accounts before any turn, and a
 * run whose accounts the backend won't freeze stops there with its reason.
 * Evidence: fixture.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  action: vi.fn(),
  admission: vi.fn(() => ({ ok: true, harness: "chatgpt-web" })),
  run: vi.fn(),
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query = mocks.query;
    mutation = mocks.mutation;
    action = mocks.action;
  },
}));
vi.mock("../../../utils/harness/local/run-resources.js", async (original) => ({
  ...(await original<typeof import("../../../utils/harness/local/run-resources.js")>()),
  shouldUseLocalHarness: async () => false,
}));
vi.mock("../../../services/evals/harness-admission.js", async (original) => ({
  ...(await original<typeof import("../../../services/evals/harness-admission.js")>()),
  checkEvalHarnessAdmission: mocks.admission,
  checkEvalExecutionAdmission: mocks.admission,
}));
vi.mock("../../../services/evals-runner.js", async (original) => ({
  ...(await original<typeof import("../../../services/evals-runner.js")>()),
  runEvalSuiteWithAiSdk: mocks.run,
}));
vi.mock("../../../services/evals/route-helpers.js", async (original) => ({
  ...(await original<typeof import("../../../services/evals/route-helpers.js")>()),
  captureToolSnapshotForEvalAuthoring: async () => ({ toolSnapshot: { servers: [] }, toolSnapshotDebug: {} }),
}));
import { prepareEvalRun } from "../evals";

const HOST = { harness: "chatgpt-web", modelId: "chatgpt-web/default", serverIds: ["s1"] };

function start() {
  return prepareEvalRun(
    {
      listServers: () => ["s1"],
      hasServer: () => true,
      getConnectionStatus: () => "connected",
      getServerNames: () => ({ s1: "s1" }),
      getServerReplayConfigs: () => [],
      listTools: async () => ({ tools: [] }),
    } as never,
    {
      suiteId: "suite-1",
      suiteRerun: true,
      projectId: "project-1",
      serverIds: ["s1"],
      tests: [],
      convexAuthToken: "token",
      orgModelConfig: { providers: [] },
    } as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CONVEX_URL = "https://test.convex.cloud";
  process.env.CONVEX_HTTP_URL = "https://test.convex.site";
  mocks.query.mockImplementation(async (name: string) => {
    if (name === "hostConfigsV2:getSuiteConfig") return HOST;
    if (name === "testSuites:listTestCases") return [];
    if (name === "testSuites:getTestSuite") return { projectId: "project-1", environment: { servers: ["s1"] } };
    if (name === "testSuites:getRunPinnedSkills") return [];
    if (name === "testSuites:resolveRunPluginServersForExecution") {
      return { servers: [], unavailable: [], droppedSnapshotServerIds: [] };
    }
    return null;
  });
});

function startedRun(record: () => Promise<unknown>) {
  mocks.mutation.mockImplementation(async (name: string) => {
    if (name === "testSuites:startTestSuiteRun") {
      return {
        runId: "run-1",
        testCases: [],
        status: "running",
        deduped: false,
        hostConfig: HOST,
        configSnapshot: { environment: { servers: ["s1"] } },
      };
    }
    if (name === "webClientSuites:recordWebAccountsAtRun") return record();
    return undefined;
  });
}

describe("a web client's suite run start", () => {
  it("freezes the run's web accounts for its vendor before any turn", async () => {
    startedRun(async () => []);
    const prepared = await start();
    expect(mocks.mutation).toHaveBeenCalledWith("webClientSuites:recordWebAccountsAtRun", {
      runId: "run-1",
      vendor: "chatgpt",
    });
    await prepared.execute();
    expect(mocks.run).toHaveBeenCalled();
  });

  it("stops the run with the backend's reason when its accounts can't be frozen", async () => {
    startedRun(async () => {
      throw new ConvexError({ code: "VALIDATION", message: "Web clients are off for this project." });
    });
    await expect(start()).rejects.toMatchObject({
      status: 400,
      message: "Web clients are off for this project.",
      details: { reason: "WEB_ACCOUNTS_UNAVAILABLE" },
    });
    expect(mocks.mutation).toHaveBeenCalledWith("testSuites:markSetupPendingIterationsFailed", {
      runId: "run-1",
      error: "Web clients are off for this project.",
    });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("stops the run as a 503, not the caller's mistake, when the backend can't be reached", async () => {
    startedRun(async () => {
      throw new Error("fetch failed");
    });
    await expect(start()).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("Run it again."),
      details: { reason: "WEB_ACCOUNTS_UNAVAILABLE" },
    });
    expect(mocks.mutation).toHaveBeenCalledWith("testSuites:markSetupPendingIterationsFailed", {
      runId: "run-1",
      error: expect.stringContaining("Run it again."),
    });
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
