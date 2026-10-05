import { describe, expect, it, vi, beforeEach } from "vitest";

// E3: `prepareSuiteReplayFromRun({ scope })` turns a replay into a subset
// rerun of its source run — and sends nothing new when no scope is set.

const startSuiteRunWithRecorderMock = vi.fn(
  async (_args: Record<string, unknown>) => ({
    runId: "replay-run-1",
    recorder: { id: "recorder" },
    config: { tests: [], environment: { servers: ["srv"] } },
    hostConfig: {},
    gradingEngine: undefined,
  }),
);
vi.mock("../recorder.js", () => ({
  startSuiteRunWithRecorder: (args: Record<string, unknown>) =>
    startSuiteRunWithRecorderMock(args),
}));

vi.mock("../../evals-runner.js", () => ({
  runEvalSuiteWithAiSdk: vi.fn(async () => undefined),
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
  fetchReplayConfig: vi.fn(async () => ({
    servers: [{ serverId: "srv", url: "https://example.test" }],
  })),
  requireConvexHttpUrl: vi.fn(() => "https://convex.test"),
  storeReplayConfig: vi.fn(async () => {}),
}));

vi.mock("../compat-runtime.js", () => ({
  loadSuiteHostConfig: vi.fn(async () => ({})),
}));

vi.mock("../replay-tool-policy.js", () => ({
  recoverToolPolicyFromSourceRun: vi.fn(async () => undefined),
}));

vi.mock("../../../utils/org-model-config.js", () => ({
  resolveOrgModelConfig: vi.fn(async () => undefined),
}));

import {
  prepareSuiteReplayFromRun,
  rerunRefusalError,
} from "../replay-suite-run.js";

function convexClient() {
  return {
    query: vi.fn(async () => ({
      suiteId: "suite-1",
      projectId: "project-1",
      hasServerReplayConfig: true,
      environment: { servers: ["srv"] },
    })),
  } as never;
}

beforeEach(() => {
  startSuiteRunWithRecorderMock.mockClear();
});

describe("prepareSuiteReplayFromRun — scope", () => {
  it("sends no rerun args when no scope is set", async () => {
    await prepareSuiteReplayFromRun({
      convexClient: convexClient(),
      convexAuthToken: "token",
      sourceRunId: "source-run",
    });
    const args = startSuiteRunWithRecorderMock.mock.calls[0]![0];
    expect(args.replayedFromRunId).toBe("source-run");
    expect(args).not.toHaveProperty("rerunOfRunId");
    expect(args).not.toHaveProperty("rerunScope");
  });

  it("reruns the source run's failed cases when scoped", async () => {
    await prepareSuiteReplayFromRun({
      convexClient: convexClient(),
      convexAuthToken: "token",
      sourceRunId: "source-run",
      scope: "failed_cases",
    });
    expect(startSuiteRunWithRecorderMock.mock.calls[0]![0]).toMatchObject({
      replayedFromRunId: "source-run",
      rerunOfRunId: "source-run",
      rerunScope: "failed_cases",
    });
  });
});

describe("rerunRefusalError", () => {
  it.each([
    ["RERUN_NOTHING_TO_RERUN", 409],
    ["RERUN_SOURCE_NOT_TERMINAL", 409],
    ["RERUN_SOURCE_SUITE_MISMATCH", 400],
  ])("maps %s to %i with the code as the reason", (code, status) => {
    const error = rerunRefusalError({ data: { code, message: "why" } });
    expect(error?.status).toBe(status);
    expect(error?.message).toBe("why");
    expect(error?.details).toEqual({ reason: code });
  });

  it("leaves anything else alone", () => {
    expect(rerunRefusalError(new Error("boom"))).toBeNull();
    expect(rerunRefusalError({ data: { code: "VALIDATION" } })).toBeNull();
  });
});
