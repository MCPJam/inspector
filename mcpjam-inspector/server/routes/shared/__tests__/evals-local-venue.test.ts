import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  available: vi.fn(), query: vi.fn(), mutation: vi.fn(), action: vi.fn(),
  admission: vi.fn(() => ({ ok: true, harness: "claude-code" })),
  run: vi.fn(),
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
import { prepareEvalRun } from "../evals";
import { prepareSuiteReplayFromRun } from "../../../services/evals/replay-suite-run";

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

describe("suite venue agreement", () => {
  it.each([true, false].flatMap(available => [true, false].map(environment => ({ available, environment }))))("uses availability=$available once with environment=$environment", async ({ available, environment }) => {
    mocks.available.mockResolvedValue(available);
    const prepared = await prepareEvalRun({
      listServers: () => ["s1"], hasServer: () => true, getConnectionStatus: () => "connected",
      getServerNames: () => ({ s1: "s1" }), getServerReplayConfigs: () => [],
      listTools: async () => ({ tools: [] }),
    } as any, {
      suiteId: "suite-1", suiteRerun: true,
      ...(environment ? { projectId: "project-1", environmentId: "env-1" } : {}),
      serverIds: ["s1"], tests: [], convexAuthToken: "token",
      runtimeVenue: "local", orgModelConfig: { providers: [] },
    } as any);
    await prepared.execute();
    const expected = available ? "local" : "hosted";
    expect(mocks.available).toHaveBeenCalledTimes(1);
    // Evals run with nobody to approve anything: the unattended scope.
    expect(mocks.available).toHaveBeenCalledWith("claude-code", "token", "project-1", { scope: "unattended" });
    expect(mocks.mutation).toHaveBeenCalledWith("testSuites:startTestSuiteRun", expect.objectContaining({ runtimeVenue: expected }));
    // A local launch declares the one harness it runs here; a hosted one, none.
    const startArgs = mocks.mutation.mock.calls.find(([name]) => name === "testSuites:startTestSuiteRun")![1];
    const declared = (startArgs.runnerCapabilities ?? []).filter((c: string) => c.startsWith("local-harness:"));
    expect(declared).toEqual(available ? ["local-harness:claude-code"] : []);
    expect(mocks.admission).toHaveBeenCalledWith(expect.objectContaining({ localExecution: available }));
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ harnessRuntimeVenue: expected }));
  });
});


it.each([true, false])("replays use the backend venue when availability=%s", async (available) => {
  mocks.available.mockResolvedValue(available);
  const prepared = await prepareSuiteReplayFromRun({
    convexClient: { query: mocks.query, mutation: mocks.mutation, action: mocks.action } as any,
    convexAuthToken: "token", sourceRunId: "source-1", orgModelConfig: { providers: [] },
  });
  await prepared.execute();
  expect(mocks.available).toHaveBeenCalledTimes(1);
  expect(mocks.available).toHaveBeenCalledWith("claude-code", "token", "project-1", { scope: "unattended" });
  expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ harnessRuntimeVenue: available ? "local" : "hosted" }));
  expect(mocks.admission).toHaveBeenCalledWith(expect.objectContaining({ localExecution: available }));
});

it.each(["harness:codex", "emulated"])("replays select venue from frozen %s engine", async (executionEngine) => {
  const original = mocks.query.getMockImplementation()!;
  mocks.query.mockImplementation(async (name: string, ...args: any[]) => name === "testSuites:getRunReplayMetadata"
    ? { suiteId: "suite-1", projectId: "project-1", hasServerReplayConfig: true, executionEngine }
    : original(name, ...args));
  mocks.available.mockImplementation(async harness => harness === "claude-code");
  const prepared = await prepareSuiteReplayFromRun({
    convexClient: { query: mocks.query, mutation: mocks.mutation, action: mocks.action } as any,
    convexAuthToken: "token", sourceRunId: "source-1", orgModelConfig: { providers: [] },
  });
  expect(mocks.available).toHaveBeenCalledWith(executionEngine === "emulated" ? undefined : "codex", "token", "project-1", { scope: "unattended" });
  expect(mocks.mutation).toHaveBeenCalledWith("testSuites:startTestSuiteRun", expect.objectContaining({ runtimeVenue: "hosted" }));
  await prepared.cleanup();
});

it("a Codex replay on a machine eligible for Codex runs locally and declares only Codex", async () => {
  const original = mocks.query.getMockImplementation()!;
  mocks.query.mockImplementation(async (name: string, ...args: any[]) => name === "testSuites:getRunReplayMetadata"
    ? { suiteId: "suite-1", projectId: "project-1", hasServerReplayConfig: true, executionEngine: "harness:codex" }
    : original(name, ...args));
  mocks.available.mockImplementation(async harness => harness === "codex");
  const prepared = await prepareSuiteReplayFromRun({
    convexClient: { query: mocks.query, mutation: mocks.mutation, action: mocks.action } as any,
    convexAuthToken: "token", sourceRunId: "source-1", orgModelConfig: { providers: [] },
  });
  const startArgs = mocks.mutation.mock.calls.find(([name]) => name === "testSuites:startTestSuiteRun")![1];
  expect(startArgs.runtimeVenue).toBe("local");
  expect((startArgs.runnerCapabilities ?? []).filter((c: string) => c.startsWith("local-harness:")))
    .toEqual(["local-harness:codex"]);
  await prepared.cleanup();
});

it("current-config replays select the current suite harness instead of the source engine", async () => {
  const original = mocks.query.getMockImplementation()!;
  mocks.query.mockImplementation(async (name: string, ...args: any[]) => name === "hostConfigsV2:getSuiteConfig"
    ? { harness: "codex" } : original(name, ...args));
  mocks.available.mockImplementation(async harness => harness === "claude-code");
  const prepared = await prepareSuiteReplayFromRun({
    convexClient: { query: mocks.query, mutation: mocks.mutation, action: mocks.action } as any,
    convexAuthToken: "token", sourceRunId: "source-1", useCurrentSuiteConfig: true, orgModelConfig: { providers: [] },
  });
  expect(mocks.available).toHaveBeenCalledWith("codex", "token", "project-1", { scope: "unattended" });
  expect(mocks.mutation).toHaveBeenCalledWith("testSuites:startTestSuiteRun", expect.objectContaining({ runtimeVenue: "hosted" }));
  await prepared.cleanup();
});

it("refuses a suite launch when its authorization project cannot be resolved", async () => {
  mocks.query.mockRejectedValue(new Error("project lookup unavailable"));
  await expect(prepareEvalRun({} as any, {
    suiteId: "suite-1", suiteRerun: true, serverIds: ["s1"], tests: [],
    convexAuthToken: "token", orgModelConfig: { providers: [] },
  } as any)).rejects.toThrow("project lookup unavailable");
  expect(mocks.mutation).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
});
