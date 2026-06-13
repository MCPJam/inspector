import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ConvexHttpClient } from "convex/browser";
import type { MCPClientManager } from "@mcpjam/sdk";
import type { EvalTestCase } from "../../evals-runner";
import type { SuiteRunRecorder } from "../recorder";

// The probe path constructs a real harness + render pipeline; mock both so
// the unit tests need no Chromium. The render mock returns whatever the
// current test configured via `renderResult`.
const { renderMcpAppToolResult, isRenderableMcpAppTool, harnessDispose } =
  vi.hoisted(() => ({
    renderMcpAppToolResult: vi.fn(),
    isRenderableMcpAppTool: vi.fn(() => true),
    harnessDispose: vi.fn(async () => {}),
  }));
vi.mock("../../../utils/mcp-app-render-observation", () => ({
  renderMcpAppToolResult,
  isRenderableMcpAppTool,
}));
vi.mock("../../../utils/mcp-app-browser-harness", () => ({
  McpAppBrowserHarness: class {
    opts: unknown;
    constructor(opts: unknown) {
      this.opts = opts;
    }
    dispose = harnessDispose;
  },
}));

const { finalizeEvalIteration } = vi.hoisted(() => ({
  finalizeEvalIteration: vi.fn(async (_params: Record<string, unknown>) => {}),
}));
vi.mock("../finalize-iteration", () => ({ finalizeEvalIteration }));

import { runProbeTestCase, PROBE_SERVER_NOT_CONNECTED } from "../probe-iteration";

const RENDERED_OBSERVATION = {
  toolCallId: "probe-1",
  toolName: "show_map",
  serverId: "maps",
  status: "rendered" as const,
  elapsedMs: 850,
  ts: 1700000000000,
};

function makeManager(opts: {
  executeTool?: ReturnType<typeof vi.fn>;
  metadata?: Record<string, unknown>;
}): MCPClientManager {
  return {
    executeTool:
      opts.executeTool ?? vi.fn(async () => ({ content: [], isError: false })),
    getAllToolsMetadata: vi.fn(() => ({
      show_map: opts.metadata ?? { "mcpjam/appTool": true },
    })),
    listServers: vi.fn(() => ["maps"]),
  } as unknown as MCPClientManager;
}

function makeRecorder(): {
  recorder: SuiteRunRecorder;
  started: Array<Record<string, unknown>>;
  finished: Array<Record<string, unknown>>;
} {
  const started: Array<Record<string, unknown>> = [];
  const finished: Array<Record<string, unknown>> = [];
  const recorder = {
    runId: "run-1",
    suiteId: "suite-1",
    async startIteration(args: Record<string, unknown>) {
      started.push(args);
      return `iter-${started.length}`;
    },
    async finishIteration(args: Record<string, unknown>) {
      finished.push(args);
    },
    async finalize() {},
  } as unknown as SuiteRunRecorder;
  return { recorder, started, finished };
}

function probeTest(over: Partial<EvalTestCase> = {}): EvalTestCase {
  return {
    title: "Map probe",
    query: "",
    runs: 1,
    model: "widget-probe",
    provider: "none",
    expectedToolCalls: [],
    caseType: "widget_probe",
    probeConfig: {
      serverId: "srv_1",
      serverName: "maps",
      toolName: "show_map",
      arguments: { city: "Berlin" },
    },
    testCaseId: "case-1",
    ...over,
  };
}

const convexClient = {} as ConvexHttpClient;

beforeEach(() => {
  vi.clearAllMocks();
  isRenderableMcpAppTool.mockReturnValue(true);
  renderMcpAppToolResult.mockResolvedValue(RENDERED_OBSERVATION);
});

describe("runProbeTestCase", () => {
  test("happy path: tool call + rendered widget passes and finalizes with artifacts", async () => {
    const { recorder, started, finished } = makeRecorder();
    const outcomes = await runProbeTestCase({
      test: probeTest(),
      resolvedServerKey: "maps",
      mcpClientManager: makeManager({}),
      recorder,
      convexClient,
      runId: "run-1",
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].evaluation.passed).toBe(true);
    expect(outcomes[0].iterationId).toBe("iter-1");
    // Pairing by testCaseId + iterationNumber — no snapshot passed.
    expect(started[0]).toMatchObject({ testCaseId: "case-1", iterationNumber: 1 });
    expect(started[0]).not.toHaveProperty("testCaseSnapshot");

    const finish = finished[0] as Record<string, any>;
    expect(finish.passed).toBe(true);
    expect(finish.status).toBe("completed");
    expect(finish.toolsCalled).toEqual([
      { toolName: "show_map", arguments: { city: "Berlin" } },
    ]);
    expect(finish.widgetRenderObservations).toEqual([
      { ...RENDERED_OBSERVATION, promptIndex: 0 },
    ]);
    expect(finish.metadata).toMatchObject({
      probe: true,
      renderLatencyMs: 850,
      renderStatus: "rendered",
    });
    expect(harnessDispose).toHaveBeenCalledTimes(1);
  });

  test("authored predicates drive the verdict (latency over budget fails)", async () => {
    const { recorder, finished } = makeRecorder();
    const outcomes = await runProbeTestCase({
      test: probeTest({
        successPredicates: [
          { type: "widgetRendered" },
          { type: "widgetRenderLatencyUnder", ms: 500 },
        ],
      }),
      resolvedServerKey: "maps",
      mcpClientManager: makeManager({}),
      recorder,
      convexClient,
      runId: "run-1",
    });

    expect(outcomes[0].evaluation.passed).toBe(false);
    const finish = finished[0] as Record<string, any>;
    expect(finish.passed).toBe(false);
    expect(finish.status).toBe("completed");
    const predicates = finish.metadata.predicates as Array<{
      predicate: { type: string };
      passed: boolean;
    }>;
    expect(predicates).toHaveLength(2);
    expect(predicates[0]).toMatchObject({
      predicate: { type: "widgetRendered" },
      passed: true,
    });
    expect(predicates[1]).toMatchObject({
      predicate: { type: "widgetRenderLatencyUnder" },
      passed: false,
    });
  });

  test("protocol error: tool call throw skips rendering, fails, records error", async () => {
    const { recorder, finished } = makeRecorder();
    const executeTool = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const outcomes = await runProbeTestCase({
      test: probeTest(),
      resolvedServerKey: "maps",
      mcpClientManager: makeManager({ executeTool }),
      recorder,
      convexClient,
      runId: "run-1",
    });

    expect(outcomes[0].evaluation.passed).toBe(false);
    const finish = finished[0] as Record<string, any>;
    expect(finish.status).toBe("completed");
    expect(finish.error).toBe("ECONNREFUSED");
    expect(finish.widgetRenderObservations).toBeUndefined();
    expect(renderMcpAppToolResult).not.toHaveBeenCalled();
  });

  test("content error (isError result) skips rendering and fails", async () => {
    const { recorder, finished } = makeRecorder();
    const executeTool = vi.fn(async () => ({
      isError: true,
      content: [{ type: "text", text: "city not found" }],
    }));
    const outcomes = await runProbeTestCase({
      test: probeTest({
        successPredicates: [{ type: "noToolErrors" }],
      }),
      resolvedServerKey: "maps",
      mcpClientManager: makeManager({ executeTool }),
      recorder,
      convexClient,
      runId: "run-1",
    });

    expect(outcomes[0].evaluation.passed).toBe(false);
    const finish = finished[0] as Record<string, any>;
    const predicates = finish.metadata.predicates as Array<{
      passed: boolean;
      reason: string;
    }>;
    expect(predicates[0].passed).toBe(false);
    expect(predicates[0].reason).toContain("city not found");
    expect(renderMcpAppToolResult).not.toHaveBeenCalled();
  });

  test("non-renderable tool records an explicit no_ui_resource observation", async () => {
    isRenderableMcpAppTool.mockReturnValue(false);
    const { recorder, finished } = makeRecorder();
    const outcomes = await runProbeTestCase({
      test: probeTest(),
      resolvedServerKey: "maps",
      mcpClientManager: makeManager({}),
      recorder,
      convexClient,
      runId: "run-1",
    });

    expect(outcomes[0].evaluation.passed).toBe(false);
    const finish = finished[0] as Record<string, any>;
    expect(finish.widgetRenderObservations).toHaveLength(1);
    expect(finish.widgetRenderObservations[0]).toMatchObject({
      status: "no_ui_resource",
      promptIndex: 0,
    });
    expect(renderMcpAppToolResult).not.toHaveBeenCalled();
  });

  test("unresolved server: iteration fails with probe_server_not_connected", async () => {
    const { recorder, finished } = makeRecorder();
    const outcomes = await runProbeTestCase({
      test: probeTest(),
      resolvedServerKey: undefined,
      mcpClientManager: makeManager({}),
      recorder,
      convexClient,
      runId: "run-1",
    });

    expect(outcomes[0].evaluation.passed).toBe(false);
    const finish = finished[0] as Record<string, any>;
    expect(finish.status).toBe("failed");
    expect(finish.error).toContain(PROBE_SERVER_NOT_CONNECTED);
    expect(finish.error).toContain("maps");
  });

  test("runs N iterations with sequential iteration numbers", async () => {
    const { recorder, started, finished } = makeRecorder();
    const outcomes = await runProbeTestCase({
      test: probeTest({ runs: 3 }),
      resolvedServerKey: "maps",
      mcpClientManager: makeManager({}),
      recorder,
      convexClient,
      runId: "run-1",
    });

    expect(outcomes).toHaveLength(3);
    expect(started.map((s) => s.iterationNumber)).toEqual([1, 2, 3]);
    expect(finished).toHaveLength(3);
  });

  test("without a recorder (quick run) finalizes via finalizeEvalIteration", async () => {
    const outcomes = await runProbeTestCase({
      test: probeTest(),
      resolvedServerKey: "maps",
      mcpClientManager: makeManager({}),
      recorder: null,
      convexClient,
      runId: null,
    });

    expect(outcomes).toHaveLength(1);
    expect(finalizeEvalIteration).toHaveBeenCalledTimes(1);
    expect(finalizeEvalIteration.mock.calls[0][0]).toMatchObject({
      passed: true,
      convexClient,
    });
  });

  test("abort signal stops before starting further iterations", async () => {
    const { recorder, finished } = makeRecorder();
    const controller = new AbortController();
    controller.abort();
    const outcomes = await runProbeTestCase({
      test: probeTest({ runs: 3 }),
      resolvedServerKey: "maps",
      mcpClientManager: makeManager({}),
      recorder,
      convexClient,
      runId: "run-1",
      abortSignal: controller.signal,
    });

    expect(outcomes).toHaveLength(0);
    expect(finished).toHaveLength(0);
  });
});
