import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  available: vi.fn(), query: vi.fn(), mutation: vi.fn(), action: vi.fn(),
  admission: vi.fn(() => ({ ok: true, harness: "claude-code" })),
  run: vi.fn(), pinned: vi.fn(),
}));
vi.mock("convex/browser", () => ({ ConvexHttpClient: class {
  setAuth() {}
  query = mocks.query;
  mutation = mocks.mutation;
  action = mocks.action;
} }));
vi.mock("../../../utils/harness/local/run-resources.js", async (original) => ({
  ...await original<typeof import("../../../utils/harness/local/run-resources.js")>(),
  shouldUseLocalHarness: mocks.available,
  isLocalHarnessVenue: () => true,
}));
vi.mock("../../../services/evals/harness-admission.js", async (original) => ({
  ...await original<typeof import("../../../services/evals/harness-admission.js")>(),
  checkEvalHarnessAdmission: mocks.admission,
  checkEvalExecutionAdmission: mocks.admission,
}));
vi.mock("../../../services/evals-runner.js", async (original) => ({
  ...await original<typeof import("../../../services/evals-runner.js")>(),
  runEvalSuiteWithAiSdk: mocks.run,
}));
vi.mock("../../../services/evals/route-helpers.js", async (original) => ({
  ...await original<typeof import("../../../services/evals/route-helpers.js")>(),
  captureToolSnapshotForEvalAuthoring: async () => ({ toolSnapshot: { servers: [] }, toolSnapshotDebug: {} }),
  fetchReplayConfig: async () => ({ servers: [{ serverId: "s1" }] }),
  buildReplayManager: () => ({ disconnectAllServers: vi.fn() }),
  connectReplayManagerServers: async () => {},
  storeReplayConfig: async () => {},
}));
vi.mock("../../../services/evals/pinned-skill-source.js", async (original) => {
  const actual = await original<typeof import("../../../services/evals/pinned-skill-source.js")>();
  return { ...actual, buildPinnedSkillSource: mocks.pinned.mockImplementation(actual.buildPinnedSkillSource) };
});
import { prepareEvalRun } from "../evals";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CONVEX_URL = "https://test.convex.cloud";
  process.env.CONVEX_HTTP_URL = "https://test.convex.site";
  mocks.query.mockImplementation(async (name: string) => {
    if (name === "projectEnvironments:getEnvironment") return { hostId: "host-1" };
    if (name === "hosts:getHost") return { config: { harness: "claude-code", serverIds: ["s1"] } };
    if (name === "projectEnvironments:resolveEnvironmentForLaunch") return {
      hostId: "host-1", hostConfigId: "config-1",
      environmentRef: { environmentId: "env-1", revision: 1, name: "Test" },
      selectedServerIds: ["s1"], effectiveServerIds: ["s1"], servers: [{ serverId: "s1", name: "s1" }],
    };
    if (name === "testSuites:getRunReplayMetadata") return { suiteId: "suite-1", projectId: "project-1", hasServerReplayConfig: true, executionEngine: "harness:claude-code" };
    if (name === "hostConfigsV2:getSuiteConfig") return { harness: "claude-code", serverIds: ["s1"] };
    if (name === "testSuites:listTestCases") return [];
    if (name === "testSuites:getTestSuite") return { projectId: "project-1", environment: { servers: ["s1"] } };
    if (name === "testSuites:getRunPinnedSkills") return [];
    if (name === "testSuites:resolveRunPluginServersForExecution") return { servers: [], unavailable: [], droppedSnapshotServerIds: [] };
    return null;
  });
  mocks.mutation.mockImplementation(async (name: string, args: any) => {
    if (name === "testSuites:startTestSuiteRun") return {
      runId: "run-1", testCases: [], status: "running", deduped: false,
      hostConfig: { harness: "claude-code", serverIds: ["s1"] },
      configSnapshot: { executionVenue: args.runtimeVenue, environment: { servers: ["s1"] } },
    };
    return undefined;
  });
});

// A climb's launch swaps the real server for the round's server. The route
// passes the swapped environment, but prepareEvalRun resolves the environment
// again for its own venue, which lists the real server: the swap must survive.
describe("a launch that replaces a server", () => {
  it("connects the replacement, not the real server, after resolving the environment again", async () => {
    mocks.available.mockResolvedValue(false);
    const prepared = await prepareEvalRun({
      listServers: () => ["s_mock"],
      hasServer: (id: string) => id === "s_mock",
      getConnectionStatus: () => "connected",
      getServerNames: () => ({ s_mock: "s1" }),
      getServerReplayConfigs: () => [],
      listTools: async () => ({ tools: [] }),
    } as any, {
      suiteId: "suite-1", suiteRerun: true, projectId: "project-1", environmentId: "env-1",
      resolvedEnvironment: {
        hostId: "host-1", hostConfigId: "config-1",
        environmentRef: { environmentId: "env-1", revision: 1, name: "Test" },
        selectedServerIds: ["s_mock"], effectiveServerIds: ["s_mock"],
        servers: [{ serverId: "s_mock", name: "s1" }],
      },
      serverReplacements: [{ serverName: "s1", replacementServerId: "s_mock", realListingHash: "listing" }],
      serverIds: ["s_mock"], tests: [], convexAuthToken: "token",
      orgModelConfig: { providers: [] },
    } as any);
    await prepared.execute();
    expect(mocks.mutation).toHaveBeenCalledWith(
      "testSuites:startTestSuiteRun",
      expect.objectContaining({ serverReplacements: [expect.objectContaining({ replacementServerId: "s_mock" })] }),
    );
  });
});
