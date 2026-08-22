/**
 * Durable conformance execution: what a replayed startRun must NEVER do.
 *
 * The route already mocks this module. These tests go through the real
 * executor so a reused row — including one still `queued` — cannot re-enter
 * `runConformance`. Recovery for a dead owner is heartbeat + sweep.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { createConvexClientMock, runConformanceMock } = vi.hoisted(() => ({
  createConvexClientMock: vi.fn(),
  runConformanceMock: vi.fn(),
}));

vi.mock("../evals/route-helpers.js", () => ({
  createConvexClient: (...args: unknown[]) => createConvexClientMock(...args),
}));

vi.mock("@mcpjam/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcpjam/sdk")>();
  return {
    ...actual,
    runConformance: (...args: unknown[]) => runConformanceMock(...args),
  };
});

import { executePersistedConformanceRun } from "../conformance-run-executor.js";

function convexClient(started: {
  runId: string;
  reused?: boolean;
  status?: string;
  outcome?: string | null;
}) {
  const mutation = vi.fn(async (fn: string) => {
    if (fn === "conformanceRuns:startRun") return started;
    if (fn === "conformanceRuns:finalizeRun") {
      return { outcome: "passed", score: 100 };
    }
    return {};
  });
  const action = vi.fn(async () => undefined);
  createConvexClientMock.mockReturnValue({ mutation, action });
  return { mutation, action };
}

const SERVER = { url: "https://connector.example.com/mcp" };

describe("executePersistedConformanceRun replay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runConformanceMock.mockResolvedValue({
      outcome: "passed",
      score: { score: 100 },
    });
  });

  it("does not re-enter runConformance when startRun reuses a queued row", async () => {
    const { mutation, action } = convexClient({
      runId: "run_1",
      reused: true,
      status: "queued",
    });
    const onRunStarted = vi.fn();

    const result = await executePersistedConformanceRun({
      convexToken: "tok",
      projectId: "p1",
      server: SERVER as never,
      source: "api",
      target: { kind: "server", serverId: "s1" },
      externalRunId: "api:p1:k1",
      onRunStarted,
    });

    expect(result).toEqual({
      runId: "run_1",
      reused: true,
      outcome: null,
    });
    expect(onRunStarted).toHaveBeenCalledWith("run_1", {
      reused: true,
      status: "queued",
    });
    expect(runConformanceMock).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(mutation.mock.calls[0]![0]).toBe("conformanceRuns:startRun");
  });

  it("does not re-enter runConformance when startRun reuses a completed row", async () => {
    convexClient({
      runId: "run_1",
      reused: true,
      status: "completed",
      outcome: "passed",
    });

    const result = await executePersistedConformanceRun({
      convexToken: "tok",
      projectId: "p1",
      server: SERVER as never,
      source: "api",
      target: { kind: "server", serverId: "s1" },
      externalRunId: "api:p1:k1",
    });

    expect(result).toEqual({
      runId: "run_1",
      reused: true,
      outcome: "passed",
    });
    expect(runConformanceMock).not.toHaveBeenCalled();
  });

  it("runs conformance for a freshly inserted row", async () => {
    const { mutation } = convexClient({
      runId: "run_1",
      reused: false,
      status: "queued",
    });

    const result = await executePersistedConformanceRun({
      convexToken: "tok",
      projectId: "p1",
      server: SERVER as never,
      suites: ["protocol"],
      source: "api",
      target: { kind: "server", serverId: "s1" },
    });

    expect(runConformanceMock).toHaveBeenCalledTimes(1);
    expect(mutation.mock.calls.map((call) => call[0])).toEqual([
      "conformanceRuns:startRun",
      "conformanceRuns:finalizeRun",
    ]);
    expect(result).toMatchObject({
      runId: "run_1",
      outcome: "passed",
      score: 100,
    });
  });
});
