const admission = vi.hoisted(() => ({ execution: vi.fn(() => ({ ok: true })), harness: vi.fn(() => ({ ok: true, harness: undefined })), policy: vi.fn(() => null), failed: vi.fn(async () => {}) }));
vi.mock("../harness-admission.js", async (original) => ({ ...await original<typeof import("../harness-admission.js")>(), checkEvalExecutionAdmission: admission.execution, checkEvalHarnessAdmission: admission.harness, casesAssertingWidgetRender: () => [], failRunBeforeExecution: admission.failed }));
vi.mock("../../../utils/harness/harness-proxy-policy-enforcement.js", () => ({ harnessToolPolicyLaunchRefusal: admission.policy }));
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Replays use the frozen client and environment; old backends fail closed
// when they cannot identify the environment whose secrets would be delivered.

const runEvalSuiteWithAiSdkMock = vi.fn(async (_options: Record<string, unknown>) => undefined);
vi.mock("../../evals-runner.js", () => ({
  runEvalSuiteWithAiSdk: (...args: unknown[]) =>
    runEvalSuiteWithAiSdkMock(args[0] as Record<string, unknown>),
}));

const startSuiteRunWithRecorderMock = vi.fn(async () => ({
  runId: "replay-run-1",
  recorder: { id: "recorder" },
  config: { tests: [], environment: { servers: ["srv"] } },
  hostConfig: { harness: "harness:cursor" },
  gradingEngine: undefined,
}));
vi.mock("../recorder.js", () => ({
  startSuiteRunWithRecorder: (...args: unknown[]) =>
    startSuiteRunWithRecorderMock(...(args as [])),
}));

vi.mock("../route-helpers.js", () => ({
  buildReplayManager: vi.fn(() => ({
    disconnectAllServers: vi.fn(async () => {}),
  })),
  captureToolSnapshotForEvalAuthoring: vi.fn(async () => ({
    toolSnapshot: {},
    toolSnapshotDebug: {},
  })),
  connectReplayManagerServers: vi.fn(async () => {}),
  fetchReplayConfig: vi.fn(async () => null),
  requireConvexHttpUrl: vi.fn(() => "https://convex.test"),
  storeReplayConfig: vi.fn(async () => {}),
}));

vi.mock("../compat-runtime.js", () => ({
  loadSuiteHostConfig: vi.fn(async () => ({ harness: "harness:cursor" })),
}));

vi.mock("@mcpjam/sdk/host-config/internal", async (importOriginal) => ({
  ...await importOriginal<typeof import("@mcpjam/sdk/host-config/internal")>(),
  resolveOpenAiCompatForHostConfig: vi.fn(() => false),
}));

vi.mock("../replay-tool-policy.js", () => ({
  recoverToolPolicyFromSourceRun: vi.fn(async () => undefined),
}));

vi.mock("../grading-mode.js", () => ({
  resolveFrozenRunGradingMode: vi.fn(() => undefined),
}));

const resolveOrgModelConfigMock = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/org-model-config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../utils/org-model-config.js")>(),
  resolveOrgModelConfig: resolveOrgModelConfigMock,
}));

import { prepareSuiteReplayFromRun } from "../replay-suite-run.js";
import { fetchReplayConfig } from "../route-helpers.js";

const PIN = { serverId: "mock-1", version: 4, contentHash: "h".repeat(64) };

function convexClient(metadata: Record<string, unknown>) {
  return {
    query: vi.fn(async () => ({
      suiteId: "suite-1",
      projectId: "project-1",
      environment: { servers: ["mock-1"] },
      ...metadata,
    })),
  } as never;
}

const openedMock = () => ({
  manager: { disconnectAllServers: vi.fn(async () => {}) },
  serverIds: ["mock-1"],
  serverBindings: [],
});

beforeEach(() => {
  runEvalSuiteWithAiSdkMock.mockClear();
  resolveOrgModelConfigMock.mockReset().mockResolvedValue({ aiKeyPolicy: { requireOrgKeys: false }, providers: [] });
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
});
afterEach(() => vi.unstubAllEnvs());

describe("prepareSuiteReplayFromRun for a run that used a mock", () => {
  it("authorizes the mock again at the version the run used, with no stored config to stand in for it", async () => {
    const open = vi.fn(async () => openedMock());
    await prepareSuiteReplayFromRun({
      convexClient: convexClient({ hasServerReplayConfig: false, mockPins: [PIN, { serverId: "x", version: 0 }] }),
      convexAuthToken: "token",
      sourceRunId: "source-run-1",
      openReplayServers: open as never,
    });
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", mockPins: [PIN], replayConfig: expect.objectContaining({ servers: [] }) }),
    );
    expect(startSuiteRunWithRecorderMock).toHaveBeenLastCalledWith(expect.objectContaining({ serverIds: ["mock-1"] }));
  });

  it("stops, naming the mock, when nothing could authorize it again", async () => {
    await expect(
      prepareSuiteReplayFromRun({
        convexClient: convexClient({ hasServerReplayConfig: false, mockPins: [PIN] }),
        convexAuthToken: "token",
        sourceRunId: "source-run-1",
        openReplayServers: (async () => undefined) as never,
      }),
    ).rejects.toThrow(/mock server.*Run the suite again/);
    expect(startSuiteRunWithRecorderMock).not.toHaveBeenCalled();
  });

  it("is unchanged for a run with no pins: no stored config still stops it", async () => {
    await expect(
      prepareSuiteReplayFromRun({
        convexClient: convexClient({ hasServerReplayConfig: false }),
        convexAuthToken: "token",
        sourceRunId: "source-run-1",
      }),
    ).rejects.toThrow("This run does not have stored replay config");
    vi.mocked(fetchReplayConfig).mockResolvedValueOnce(null);
    await expect(
      prepareSuiteReplayFromRun({
        convexClient: convexClient({ hasServerReplayConfig: true, mockPins: [] }),
        convexAuthToken: "token",
        sourceRunId: "source-run-1",
      }),
    ).rejects.toThrow("No replay configuration found for this run");
  });
});
