import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * What a REPLAY tells the runner about its Project Environment — and why the
 * honest answer is neither an id nor silence.
 *
 * A replay run genuinely HAS an environment: `startTestSuiteRun` copies the
 * source run's `configSnapshot.environmentRef` forward verbatim, and
 * `resolveGrantForSandbox` follows that id, so the replay's boxes really can
 * carry a brokered secret's egress transform. But nothing projects that ref
 * back out — not the run-start return (it carries `configSnapshot.environment`,
 * the servers snapshot, and no `environmentRef`), not `getRunReplayMetadata`,
 * not the sandbox reservation — so this process cannot name it.
 *
 * Staying silent would make the harness read the absence as "no environment,
 * therefore nothing granted" and tell the reader to fix a selection they never
 * made. These cases pin the alternative: an explicit reason, and no invented id.
 */

const runEvalSuiteWithAiSdkMock = vi.fn(async () => undefined);
vi.mock("../../evals-runner.js", () => ({
  runEvalSuiteWithAiSdk: (...args: unknown[]) =>
    runEvalSuiteWithAiSdkMock(...(args as [])),
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
