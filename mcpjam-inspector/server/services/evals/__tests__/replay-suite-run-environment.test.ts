import { describe, expect, it, vi, beforeEach } from "vitest";

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
  fetchReplayConfig: vi.fn(async () => ({
    servers: [{ serverId: "srv", url: "https://example.test" }],
  })),
  requireConvexHttpUrl: vi.fn(() => "https://convex.test"),
  storeReplayConfig: vi.fn(async () => {}),
}));

vi.mock("../compat-runtime.js", () => ({
  loadSuiteHostConfig: vi.fn(async () => ({ harness: "harness:cursor" })),
}));

vi.mock("@mcpjam/sdk/host-config/internal", () => ({
  resolveOpenAiCompatForHostConfig: vi.fn(() => false),
}));

vi.mock("../replay-tool-policy.js", () => ({
  recoverToolPolicyFromSourceRun: vi.fn(async () => undefined),
}));

vi.mock("../grading-mode.js", () => ({
  resolveFrozenRunGradingMode: vi.fn(() => undefined),
}));

vi.mock("../../../utils/org-model-config.js", () => ({
  resolveOrgModelConfig: vi.fn(async () => undefined),
}));

import { prepareSuiteReplayFromRun } from "../replay-suite-run.js";

/** A source run that WAS environment-backed, replayed by an ordinary caller. */
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
  runEvalSuiteWithAiSdkMock.mockClear();
});

describe("prepareSuiteReplayFromRun — the environment it cannot name", () => {
  it("hands the runner a REASON instead of silence, and never an invented id", async () => {
    const prepared = await prepareSuiteReplayFromRun({
      convexClient: convexClient(),
      convexAuthToken: "token",
      sourceRunId: "source-run-1",
    });
    await prepared.execute();

    expect(runEvalSuiteWithAiSdkMock).toHaveBeenCalledTimes(1);
    const options = runEvalSuiteWithAiSdkMock.mock.calls[0]![0] as unknown as {
      projectEnvironmentId?: string;
      projectEnvironmentUnresolvedReason?: string;
    };

    // Guessing an id would be the worse failure of the two: it would let the
    // harness check a selection belonging to some OTHER environment and start
    // a turn on the strength of it.
    expect(options.projectEnvironmentId).toBeUndefined();

    // Non-vacuous: a real, non-empty explanation naming replay — this is the
    // whole payload, so an empty or missing string is a broken thread.
    expect(typeof options.projectEnvironmentUnresolvedReason).toBe("string");
    expect(options.projectEnvironmentUnresolvedReason!.length).toBeGreaterThan(
      20,
    );
    expect(options.projectEnvironmentUnresolvedReason).toMatch(/replay/i);
    expect(options.projectEnvironmentUnresolvedReason).toMatch(
      /Project Environment/,
    );
  });
});

it("passes the saved Claude client and frozen environment to the shared executor", async () => {
  startSuiteRunWithRecorderMock.mockResolvedValueOnce({
    runId: "local-replay", recorder: { id: "recorder" },
    config: { tests: [], environment: { servers: ["srv"] } },
    hostConfig: { harness: "claude-code" }, gradingEngine: undefined,
    environmentRef: { environmentId: "frozen-environment" },
  } as any);
  const prepared = await prepareSuiteReplayFromRun({
    convexClient: convexClient(), convexAuthToken: "token", sourceRunId: "source",
  });
  await prepared.execute();
  expect(runEvalSuiteWithAiSdkMock).toHaveBeenCalledWith(expect.objectContaining({
    suiteHostConfig: { harness: "claude-code" },
    projectEnvironmentId: "frozen-environment",
  }));
  expect(runEvalSuiteWithAiSdkMock.mock.calls[0]?.[0]).not.toHaveProperty("projectEnvironmentUnresolvedReason");
});
