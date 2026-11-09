/**
 * The executor with saved settings, a deadline and the heartbeat's cancel
 * watch. Convex and the SDK run are mocked; the parity test drives the real
 * suites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createConvexClientMock, runConformanceMock } = vi.hoisted(() => ({
  createConvexClientMock: vi.fn(),
  runConformanceMock: vi.fn(),
}));

vi.mock("../evals/route-helpers.js", () => ({
  createConvexClient: (...args: unknown[]) => createConvexClientMock(...args),
}));
vi.mock("@mcpjam/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mcpjam/sdk")>()),
  runConformance: (...args: unknown[]) => runConformanceMock(...args),
}));

import { executePersistedConformanceRun } from "../conformance-run-executor.js";
import type {
  ConformanceRunSettings,
  ConformanceSuiteConfigs,
} from "../conformance-run-settings.js";

const SERVER = { url: "https://connector.example.com/mcp" };
const SAVED: ConformanceRunSettings = {
  source: "saved",
  selection: { protocol: ["tools-list"], tasks: ["tasks-wire-resolvable"] },
  probes: {},
  runTimeoutSeconds: 45,
};

type Call = { fn: string; args: Record<string, unknown> };

function convexClient(heartbeat: () => unknown = () => ({ ok: true })) {
  const calls: Call[] = [];
  const mutation = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    if (fn === "conformanceRuns:startRun") return { runId: "run_1" };
    if (fn === "conformanceRuns:heartbeat") return heartbeat();
    if (fn === "conformanceRuns:finalizeRun") {
      return { outcome: "incomplete", score: null };
    }
    return {};
  });
  const action = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
  });
  createConvexClientMock.mockReturnValue({ mutation, action });
  return { calls, mutation, action };
}

/** A run whose suites stop only when its signal aborts. */
function runUntilAborted() {
  runConformanceMock.mockImplementation(
    (config: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        config.signal.addEventListener(
          "abort",
          () => reject(config.signal.reason),
          { once: true },
        );
      }),
  );
}

function reportErrors(calls: Call[]): Record<string, unknown> {
  return Object.fromEntries(
    calls
      .filter((call) => call.fn === "conformanceRuns:upsertReportAction")
      .map((call) => {
        const report = call.args.report as {
          groups: Array<{ cases: Array<{ error?: string }> }>;
        };
        return [call.args.suiteKind, report.groups[0]?.cases[0]?.error];
      }),
  );
}

/** Configs a start resolved at 2025-11-25, with every saved suite kept. */
const RESOLVED = {
  protocolVersion: "2025-11-25" as const,
  selection: SAVED.selection,
  protocol: {},
  apps: {},
  tasks: {},
};

const BASE = {
  convexToken: "tok",
  projectId: "p1",
  server: SERVER as never,
  source: "api" as const,
  target: { kind: "server" as const, serverId: "s1" },
  actorLabel: "MCPJam API",
};

describe("executePersistedConformanceRun with saved settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the run with its budget and runs each suite with the configs the start resolved", async () => {
    const { calls } = convexClient();
    const configs = {
      protocolVersion: "2026-07-28",
      selection: SAVED.selection,
      protocol: { checkIds: ["tools-list"] },
      apps: {},
      tasks: { checkIds: ["tasks-wire-resolvable"] },
    } as ConformanceSuiteConfigs;
    runConformanceMock.mockResolvedValue({
      outcome: "passed",
      score: { score: 100 },
    });

    await executePersistedConformanceRun({
      ...BASE,
      suites: ["protocol", "tasks"],
      protocolVersion: "2026-07-28",
      settings: SAVED,
      suiteConfigs: configs,
      runTimeoutSeconds: SAVED.runTimeoutSeconds,
    });

    expect(calls[0]).toMatchObject({
      fn: "conformanceRuns:startRun",
      args: {
        requestedSuites: ["protocol", "tasks"],
        runTimeoutSeconds: 45,
        actorLabel: "MCPJam API",
      },
    });
    const config = runConformanceMock.mock.calls[0]![0];
    expect(config).toMatchObject({
      suites: ["protocol", "tasks"],
      protocolVersion: "2026-07-28",
      protocol: configs.protocol,
      tasks: configs.tasks,
    });
    expect(config.signal).toBeInstanceOf(AbortSignal);
  });

  it("records the declared launcher and the settings the run used", async () => {
    const { calls } = convexClient();
    runConformanceMock.mockResolvedValue({
      outcome: "passed",
      score: { score: 100 },
    });

    await executePersistedConformanceRun({
      ...BASE,
      suites: ["protocol"],
      settings: SAVED,
      suiteConfigs: { protocolVersion: undefined },
      runTimeoutSeconds: 300,
      launcher: { kind: "mcp", client: "claude-code" },
    });
    expect(calls[0]!.args).toMatchObject({
      launcher: { kind: "mcp", client: "claude-code" },
      settingsSource: "saved",
    });

    // A worker start declares neither, and sends neither.
    vi.clearAllMocks();
    const worker = convexClient();
    runConformanceMock.mockResolvedValue({
      outcome: "passed",
      score: { score: 100 },
    });
    await executePersistedConformanceRun({ ...BASE, suites: ["protocol"] });
    expect(worker.calls[0]!.args).not.toHaveProperty("launcher");
    expect(worker.calls[0]!.args).not.toHaveProperty("settingsSource");
  });

  it("stops within one heartbeat of a cancel and writes no report after it", async () => {
    vi.useFakeTimers();
    const { calls } = convexClient(() => ({ ok: false, error: "terminal" }));
    runUntilAborted();

    const run = executePersistedConformanceRun({
      ...BASE,
      suites: ["protocol"],
      settings: SAVED,
      suiteConfigs: RESOLVED,
      runTimeoutSeconds: 300,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await run;

    const config = runConformanceMock.mock.calls[0]![0];
    expect(config.signal.aborted).toBe(true);
    expect(
      calls.some((call) => call.fn === "conformanceRuns:upsertReportAction"),
    ).toBe(false);
    expect(calls.at(-1)?.fn).toBe("conformanceRuns:finalizeRun");
  });

  it("ends every unfinished suite incomplete at the run's budget", async () => {
    vi.useFakeTimers();
    const { calls } = convexClient();
    // Suites that ignore the signal: the executor must not wait for them.
    runConformanceMock.mockImplementation(() => new Promise(() => undefined));

    const run = executePersistedConformanceRun({
      ...BASE,
      suites: ["protocol", "tasks"],
      settings: SAVED,
      suiteConfigs: RESOLVED,
      runTimeoutSeconds: 5,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await run;

    expect(reportErrors(calls)).toEqual({
      protocol: "Run timed out after 5 seconds",
      tasks: "Run timed out after 5 seconds",
    });
    expect(calls.at(-1)?.fn).toBe("conformanceRuns:finalizeRun");
  });

  it("records a suite that reports after the budget as timed out, not with its cut-off report", async () => {
    vi.useFakeTimers();
    const { calls } = convexClient();
    suiteConfigsForRunMock.mockResolvedValue({
      protocolVersion: "2025-11-25",
      selection: SAVED.selection,
      protocol: {},
      apps: {},
      tasks: {},
    });
    // A suite whose requests the deadline aborted still reports, with every
    // check failed on the aborted request.
    runConformanceMock.mockImplementation(
      (config: {
        signal: AbortSignal;
        onProgress: (event: unknown) => Promise<void> | void;
      }) =>
        new Promise((resolve) => {
          config.signal.addEventListener(
            "abort",
            () => {
              void config.onProgress({
                suiteKind: "protocol",
                status: "completed",
                report: {
                  schemaVersion: 1,
                  kind: "protocol-conformance",
                  name: "protocol",
                  passed: false,
                  outcome: "failed",
                  durationMs: 5_000,
                  groups: [
                    {
                      id: "core",
                      title: "Core",
                      target: "",
                      passed: false,
                      durationMs: 5_000,
                      cases: [
                        {
                          id: "tools-list",
                          title: "tools/list",
                          status: "failed",
                          durationMs: 5_000,
                          category: "core",
                          error: "This operation was aborted",
                        },
                      ],
                    },
                  ],
                },
              });
              resolve({ outcome: "failed", score: { score: 0 } });
            },
            { once: true },
          );
        }),
    );

    const run = executePersistedConformanceRun({
      ...BASE,
      suites: ["protocol"],
      settings: SAVED,
      runTimeoutSeconds: 5,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await run;

    expect(
      calls.filter((call) => call.fn === "conformanceRuns:upsertReportAction"),
    ).toHaveLength(1);
    expect(reportErrors(calls)).toEqual({
      protocol: "Run timed out after 5 seconds",
    });
    expect(calls.at(-1)?.fn).toBe("conformanceRuns:finalizeRun");
  });

  it("keeps a report whose write began before the budget ran out", async () => {
    vi.useFakeTimers();
    const { calls, action } = convexClient();
    action.mockImplementation(
      async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        // The protocol report's write is still in flight at the deadline.
        if (args.status === "completed") {
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
      },
    );
    suiteConfigsForRunMock.mockResolvedValue({
      protocolVersion: "2025-11-25",
      selection: SAVED.selection,
      protocol: {},
      apps: {},
      tasks: {},
    });
    runConformanceMock.mockImplementation(
      (config: { onProgress: (event: unknown) => Promise<void> | void }) => {
        void config.onProgress({
          suiteKind: "protocol",
          status: "completed",
          report: {
            schemaVersion: 1,
            kind: "protocol-conformance",
            name: "protocol",
            passed: true,
            outcome: "passed",
            durationMs: 1,
            groups: [],
          },
        });
        // Tasks never finishes.
        return new Promise(() => undefined);
      },
    );

    const run = executePersistedConformanceRun({
      ...BASE,
      suites: ["protocol", "tasks"],
      settings: SAVED,
      runTimeoutSeconds: 2,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await run;

    const writes = calls.filter(
      (call) => call.fn === "conformanceRuns:upsertReportAction",
    );
    expect(writes.map((call) => [call.args.suiteKind, call.args.status])).toEqual(
      [
        ["protocol", "completed"],
        ["tasks", "failed"],
      ],
    );
    expect(reportErrors(calls)).toEqual({
      protocol: undefined,
      tasks: "Run timed out after 2 seconds",
    });
    expect(calls.at(-1)?.fn).toBe("conformanceRuns:finalizeRun");
  });

  it("reads a report write refused after a cancel as the cancel, not a failure", async () => {
    const { calls, action } = convexClient();
    action.mockRejectedValue(
      Object.assign(new Error("immutable"), {
        data: { code: "CONFORMANCE_RUN_IMMUTABLE" },
      }),
    );
    runConformanceMock.mockImplementation(
      async (config: {
        onProgress: (event: unknown) => Promise<void>;
        signal: AbortSignal;
      }) => {
        await config.onProgress({
          suiteKind: "protocol",
          status: "completed",
          report: {
            schemaVersion: 1,
            kind: "protocol-conformance",
            name: "protocol",
            passed: true,
            outcome: "passed",
            durationMs: 1,
            groups: [],
          },
        });
        expect(config.signal.aborted).toBe(true);
        return { outcome: "passed", score: { score: 100 } };
      },
    );

    await expect(
      executePersistedConformanceRun({
        ...BASE,
        suites: ["protocol", "oauth"],
        runTimeoutSeconds: 300,
      }),
    ).resolves.toMatchObject({ runId: "run_1" });
    // The unsupported OAuth suite's report is not attempted once cancelled.
    expect(action).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)?.fn).toBe("conformanceRuns:finalizeRun");
  });
});
