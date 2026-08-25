const sentryMocks = vi.hoisted(() => ({
  captureEvalReportingFailure: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/sentry", () => ({
  captureEvalReportingFailure: sentryMocks.captureEvalReportingFailure,
}));

import { createEvalRunReporter } from "../src/eval-run-reporter";
import { __resetPrintedRunUrls } from "../src/report-eval-results";
import { PromptResult } from "../src/PromptResult";
import type { EvalRunResult, IterationResult } from "../src/EvalTest";

const successSummary = {
  total: 3,
  passed: 3,
  failed: 0,
  passRate: 1,
};

function okResponse(body: Record<string, unknown>): any {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ ok: true, ...body }),
  };
}

describe("createEvalRunReporter", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    sentryMocks.captureEvalReportingFailure.mockClear();
    vi.restoreAllMocks();
  });

  it("generates monotonic externalIterationId values across multiple flushes", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          suiteId: "suite_1",
          runId: "run_1",
          status: "running",
          result: "pending",
        })
      )
      .mockResolvedValueOnce(okResponse({ inserted: 2, skipped: 0, total: 2 }))
      .mockResolvedValueOnce(okResponse({ inserted: 1, skipped: 0, total: 1 }))
      .mockResolvedValueOnce(
        okResponse({
          suiteId: "suite_1",
          runId: "run_1",
          status: "completed",
          result: "passed",
          summary: successSummary,
        })
      );
    global.fetch = fetchMock as any;

    const reporter = createEvalRunReporter({
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      suiteName: "chunked-reporter",
    });

    reporter.add({ caseTitle: "case-1", passed: true });
    reporter.add({ caseTitle: "case-2", passed: true });
    await reporter.flush();

    reporter.add({ caseTitle: "case-3", passed: true });
    await reporter.flush();

    await reporter.finalize();

    const startBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const externalRunId = startBody.externalRunId as string;

    const firstAppendBody = JSON.parse(
      fetchMock.mock.calls[1][1].body as string
    );
    expect(
      firstAppendBody.results.map((result: any) => result.externalIterationId)
    ).toEqual([`${externalRunId}-1`, `${externalRunId}-2`]);

    const secondAppendBody = JSON.parse(
      fetchMock.mock.calls[2][1].body as string
    );
    expect(
      secondAppendBody.results.map((result: any) => result.externalIterationId)
    ).toEqual([`${externalRunId}-3`]);
  });

  it("flush uploads widget snapshots before append iterations", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          suiteId: "suite_1",
          runId: "run_1",
          status: "running",
          result: "pending",
        })
      )
      .mockResolvedValueOnce(
        okResponse({
          uploadUrl: "https://upload.example.com/widget-1",
        })
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ storageId: "blob_123" }),
      })
      .mockResolvedValueOnce(okResponse({ inserted: 1, skipped: 0, total: 1 }));
    global.fetch = fetchMock as any;

    const reporter = createEvalRunReporter({
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      suiteName: "widget-flush",
    });

    reporter.add({
      caseTitle: "with-widget",
      passed: true,
      widgetSnapshots: [
        {
          toolCallId: "call-1",
          toolName: "create_view",
          protocol: "mcp-apps",
          serverId: "server-1",
          resourceUri: "ui://widget/create-view.html",
          toolMetadata: {
            ui: { resourceUri: "ui://widget/create-view.html" },
          },
          widgetCsp: null,
          widgetPermissions: null,
          widgetPermissive: true,
          prefersBorder: true,
          widgetHtml: "<html>test</html>",
        },
      ],
    });
    await reporter.flush();

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://example.com/api/v1/projects/default/eval-ingest/runs/start"
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://example.com/api/v1/projects/default/eval-ingest/artifacts/upload-url"
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      "https://upload.example.com/widget-1"
    );
    expect(fetchMock.mock.calls[3][0]).toBe(
      "https://example.com/api/v1/projects/default/eval-ingest/runs/iterations"
    );

    const appendBody = JSON.parse(fetchMock.mock.calls[3][1].body as string);
    expect(appendBody.results[0].widgetSnapshots[0]).toEqual(
      expect.objectContaining({
        toolCallId: "call-1",
        widgetHtmlBlobId: "blob_123",
      })
    );
    expect(appendBody.results[0].widgetSnapshots[0].widgetHtml).toBeUndefined();
  });

  it("forwards serverReplayConfigs when starting a chunked run", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          suiteId: "suite_1",
          runId: "run_1",
          status: "running",
          result: "pending",
        })
      )
      .mockResolvedValueOnce(okResponse({ inserted: 1, skipped: 0, total: 1 }))
      .mockResolvedValueOnce(
        okResponse({
          suiteId: "suite_1",
          runId: "run_1",
          status: "completed",
          result: "passed",
          summary: successSummary,
        })
      );
    global.fetch = fetchMock as any;

    const reporter = createEvalRunReporter({
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      suiteName: "chunked-reporter",
      serverReplayConfigs: [
        {
          serverId: "remote",
          url: "https://example.com/mcp",
          accessToken: "at_123",
        },
      ],
    });

    reporter.add({
      caseTitle: "case-1",
      passed: true,
      trace: "x".repeat(1024 * 1024),
    });
    await reporter.flush();
    await reporter.finalize();

    const startBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(startBody.serverReplayConfigs).toEqual([
      {
        serverId: "remote",
        url: "https://example.com/mcp",
        accessToken: "at_123",
      },
    ]);
  });

  it("resolves replay configs from agent for one-shot finalize", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        suiteId: "suite_1",
        runId: "run_1",
        status: "completed",
        result: "passed",
        summary: successSummary,
      })
    );
    global.fetch = fetchMock as any;

    const agent = {
      getServerReplayConfigs: vi.fn().mockReturnValue([
        {
          serverId: "agent",
          url: "https://agent.example.com/mcp",
          accessToken: "at_agent",
        },
      ]),
    };

    const reporter = createEvalRunReporter({
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      suiteName: "one-shot-reporter",
      agent,
    });

    reporter.add({ caseTitle: "case-1", passed: true });
    await reporter.finalize();

    expect(agent.getServerReplayConfigs).toHaveBeenCalledTimes(1);
    const reportBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(reportBody.serverReplayConfigs).toEqual([
      {
        serverId: "agent",
        url: "https://agent.example.com/mcp",
        accessToken: "at_agent",
      },
    ]);
  });

  describe("verdict policy 2 wire protocol", () => {
    const verdictPolicy = {
      verdictPolicyVersion: 2 as const,
      defaults: {
        repetitions: 3,
        // A FRACTION. The legacy field on the same body is a 0-100 percent, so
        // a test that used 60 here would pass against code that confused them.
        passThreshold: 0.6,
        validity: { minCompletionRate: 0.9 },
      },
      cases: [{ caseId: "case-1", repetitions: 2, passThreshold: 0.5 }],
    };
    const inconclusiveRun = {
      suiteId: "suite_1",
      runId: "run_1",
      status: "completed",
      result: "inconclusive",
      summary: { total: 2, passed: 1, failed: 1, passRate: 0.5 },
      verdictPolicyVersion: 2,
      verdictSummary: {
        policyVersion: 2,
        verdict: "inconclusive",
        reasons: ["insufficientCompletion"],
      },
    };

    it("sends the policy on run START and explicit statuses on the chunks", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          okResponse({
            suiteId: "suite_1",
            runId: "run_1",
            status: "running",
            result: "pending",
          })
        )
        .mockResolvedValueOnce(okResponse({ inserted: 3, skipped: 0, total: 3 }))
        .mockResolvedValueOnce(okResponse(inconclusiveRun));
      global.fetch = fetchMock as any;

      const reporter = createEvalRunReporter({
        apiKey: "sk_test_key",
        baseUrl: "https://example.com",
        suiteName: "v2-chunked",
        verdictPolicy,
      });

      // Three lifecycle statuses that CANNOT be derived from `passed`: a
      // graded failure that ran fine, a setup abort, and a deliberate skip.
      reporter.add({ caseTitle: "case-1", passed: false, status: "completed" });
      reporter.add({
        caseTitle: "case-1",
        passed: false,
        status: "setup_failed",
        error: "server never started",
      });
      reporter.add({ caseTitle: "case-1", passed: false, status: "skipped" });
      await reporter.flush();
      const result = await reporter.finalize();

      const startBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(startBody.verdictPolicy).toEqual(verdictPolicy);

      const appendBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
      expect(appendBody.results.map((r: any) => r.status)).toEqual([
        "completed",
        "setup_failed",
        "skipped",
      ]);
      // Policy rides the START call only: a chunk carries evidence, never a
      // policy that could disagree with the frozen snapshot.
      expect(appendBody.verdictPolicy).toBeUndefined();

      // And the backend's decision comes back untouched — `inconclusive` is
      // not collapsed into `failed`, and the decision travels with it.
      expect(result.result).toBe("inconclusive");
      expect(result.verdictPolicyVersion).toBe(2);
      expect(result.verdictSummary).toEqual(inconclusiveRun.verdictSummary);
    });

    it("sends the policy on the one-shot body and preserves the decision", async () => {
      const fetchMock = vi.fn().mockResolvedValue(okResponse(inconclusiveRun));
      global.fetch = fetchMock as any;

      const reporter = createEvalRunReporter({
        apiKey: "sk_test_key",
        baseUrl: "https://example.com",
        suiteName: "v2-one-shot",
        verdictPolicy,
      });

      reporter.add({ caseTitle: "case-1", passed: true, status: "completed" });
      const result = await reporter.finalize();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.verdictPolicy).toEqual(verdictPolicy);
      expect(body.results.map((r: any) => r.status)).toEqual(["completed"]);
      expect(result.result).toBe("inconclusive");
      expect(result.verdictSummary).toEqual(inconclusiveRun.verdictSummary);
    });

    it("omits the policy entirely for a legacy run", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        okResponse({
          suiteId: "suite_1",
          runId: "run_1",
          status: "completed",
          result: "passed",
          summary: successSummary,
        })
      );
      global.fetch = fetchMock as any;

      const reporter = createEvalRunReporter({
        apiKey: "sk_test_key",
        baseUrl: "https://example.com",
        suiteName: "legacy",
        passCriteria: { minimumPassRate: 80 },
      });
      reporter.add({ caseTitle: "case-1", passed: true });
      const result = await reporter.finalize();

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect("verdictPolicy" in body).toBe(false);
      // The percent threshold is still a percent at the legacy boundary.
      expect(body.passCriteria).toEqual({ minimumPassRate: 80 });
      expect(result.verdictPolicyVersion).toBeUndefined();
      expect(result.verdictSummary).toBeUndefined();
    });
  });

  it("resolves replay configs from mcpClientManager when starting a chunked run", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          suiteId: "suite_1",
          runId: "run_1",
          status: "running",
          result: "pending",
        })
      )
      .mockResolvedValueOnce(okResponse({ inserted: 1, skipped: 0, total: 1 }))
      .mockResolvedValueOnce(
        okResponse({
          suiteId: "suite_1",
          runId: "run_1",
          status: "completed",
          result: "passed",
          summary: successSummary,
        })
      );
    global.fetch = fetchMock as any;

    const agent = {
      getServerReplayConfigs: vi.fn().mockReturnValue([]),
    };
    const mcpClientManager = {
      getServerReplayConfigs: vi.fn().mockReturnValue([
        {
          serverId: "manager",
          url: "https://manager.example.com/mcp",
          refreshToken: "rt_manager",
          clientId: "cid_manager",
        },
      ]),
    };

    const reporter = createEvalRunReporter({
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      suiteName: "chunked-manager-replay",
      agent,
      mcpClientManager: mcpClientManager as any,
    });

    reporter.add({
      caseTitle: "case-1",
      passed: true,
      trace: "x".repeat(1024 * 1024),
    });
    await reporter.flush();
    await reporter.finalize();

    expect(agent.getServerReplayConfigs).toHaveBeenCalledTimes(1);
    expect(mcpClientManager.getServerReplayConfigs).toHaveBeenCalledTimes(1);
    const startBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(startBody.serverReplayConfigs).toEqual([
      {
        serverId: "manager",
        url: "https://manager.example.com/mcp",
        refreshToken: "rt_manager",
        clientId: "cid_manager",
      },
    ]);
  });

  it("filters inferred replay configs by serverNames for reporter uploads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        suiteId: "suite_1",
        runId: "run_1",
        status: "completed",
        result: "passed",
        summary: successSummary,
      })
    );
    global.fetch = fetchMock as any;

    const agent = {
      getServerReplayConfigs: vi.fn().mockReturnValue([
        {
          serverId: "asana",
          url: "https://asana.example.com/mcp",
          accessToken: "at_asana",
        },
        {
          serverId: "github",
          url: "https://github.example.com/mcp",
          accessToken: "at_github",
        },
      ]),
    };

    const reporter = createEvalRunReporter({
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      suiteName: "filtered-reporter",
      serverNames: ["asana"],
      agent,
    });

    reporter.add({ caseTitle: "case-1", passed: true });
    await reporter.finalize();

    const reportBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(reportBody.serverReplayConfigs).toEqual([
      {
        serverId: "asana",
        url: "https://asana.example.com/mcp",
        accessToken: "at_asana",
      },
    ]);
  });

  describe("getAddedCount", () => {
    it("tracks total added results", () => {
      const reporter = createEvalRunReporter({
        apiKey: "sk_test_key",
        baseUrl: "https://example.com",
        suiteName: "count-test",
      });

      expect(reporter.getAddedCount()).toBe(0);
      reporter.add({ caseTitle: "a", passed: true });
      reporter.add({ caseTitle: "b", passed: false });
      expect(reporter.getAddedCount()).toBe(2);
    });

    it("counts results provided in constructor", () => {
      const reporter = createEvalRunReporter({
        apiKey: "sk_test_key",
        baseUrl: "https://example.com",
        suiteName: "count-test",
        results: [
          { caseTitle: "a", passed: true },
          { caseTitle: "b", passed: true },
        ],
      });

      expect(reporter.getAddedCount()).toBe(2);
    });
  });

  describe("addFromPrompt / recordFromPrompt", () => {
    it("addFromPrompt converts and adds a PromptResult", () => {
      const reporter = createEvalRunReporter({
        apiKey: "sk_test_key",
        baseUrl: "https://example.com",
        suiteName: "prompt-test",
      });

      const pr = PromptResult.from({
        prompt: "test query",
        messages: [{ role: "user", content: "test query" }],
        text: "response",
        toolCalls: [{ toolName: "my_tool", arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        latency: { e2eMs: 100, llmMs: 80, mcpMs: 20 },
        provider: "openai",
        model: "gpt-4o",
      });

      reporter.addFromPrompt(pr, { caseTitle: "my-case", passed: true });
      expect(reporter.getAddedCount()).toBe(1);
      expect(reporter.getBufferedCount()).toBe(1);
    });

    it("addFromPrompt uses prompt metadata as defaults", () => {
      const reporter = createEvalRunReporter({
        apiKey: "sk_test_key",
        baseUrl: "https://example.com",
        suiteName: "prompt-test",
      });

      const pr = PromptResult.from({
        prompt: "test",
        messages: [],
        text: "",
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        latency: { e2eMs: 0, llmMs: 0, mcpMs: 0 },
        provider: "anthropic",
        model: "claude-3-5-sonnet",
      });

      reporter.addFromPrompt(pr, { caseTitle: "test", passed: true });
      expect(reporter.getAddedCount()).toBe(1);
    });
  });

  describe("addFromRun / addFromSuiteRun", () => {
    function createMockIterationResult(passed: boolean): IterationResult {
      const pr = PromptResult.from({
        prompt: "test",
        messages: [{ role: "user", content: "test" }],
        text: "ok",
        toolCalls: [{ toolName: "my_tool", arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        latency: { e2eMs: 100, llmMs: 80, mcpMs: 20 },
        provider: "openai",
        model: "gpt-4o",
      });

      return {
        passed,
        latencies: [{ e2eMs: 100, llmMs: 80, mcpMs: 20 }],
        tokens: { total: 15, input: 10, output: 5 },
        prompts: [pr],
        retryCount: 0,
      };
    }

    function createMockRunResult(count: number): EvalRunResult {
      const iterations = Array.from({ length: count }, (_, i) =>
        createMockIterationResult(i % 2 === 0)
      );

      return {
        iterations: count,
        successes: iterations.filter((i) => i.passed).length,
        failures: iterations.filter((i) => !i.passed).length,
        results: iterations.map((i) => i.passed),
        iterationDetails: iterations,
        tokenUsage: {
          total: 15 * count,
          input: 10 * count,
          output: 5 * count,
          perIteration: iterations.map((i) => i.tokens),
        },
        latency: {
          e2e: { min: 100, max: 100, mean: 100, p50: 100, p95: 100, count },
          llm: { min: 80, max: 80, mean: 80, p50: 80, p95: 80, count },
          mcp: { min: 20, max: 20, mean: 20, p50: 20, p95: 20, count },
          perIteration: iterations.flatMap((i) => i.latencies),
        },
      };
    }

    it("addFromRun converts all iterations", () => {
      const reporter = createEvalRunReporter({
        apiKey: "sk_test_key",
        baseUrl: "https://example.com",
        suiteName: "run-test",
      });

      const run = createMockRunResult(3);
      reporter.addFromRun(run, { casePrefix: "test-case" });
      expect(reporter.getAddedCount()).toBe(3);
      expect(reporter.getBufferedCount()).toBe(3);
    });

    it("addFromSuiteRun converts all tests and iterations", () => {
      const reporter = createEvalRunReporter({
        apiKey: "sk_test_key",
        baseUrl: "https://example.com",
        suiteName: "suite-test",
      });

      const suiteRun = new Map<string, EvalRunResult>();
      suiteRun.set("test-a", createMockRunResult(2));
      suiteRun.set("test-b", createMockRunResult(3));

      reporter.addFromSuiteRun(suiteRun, { casePrefix: "suite" });
      expect(reporter.getAddedCount()).toBe(5);
      expect(reporter.getBufferedCount()).toBe(5);
    });
  });

  describe("recordFromRun / recordFromSuiteRun", () => {
    function createMockIterationResult(passed: boolean): IterationResult {
      const pr = PromptResult.from({
        prompt: "test",
        messages: [{ role: "user", content: "test" }],
        text: "ok",
        toolCalls: [{ toolName: "my_tool", arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        latency: { e2eMs: 100, llmMs: 80, mcpMs: 20 },
        provider: "openai",
        model: "gpt-4o",
      });

      return {
        passed,
        latencies: [{ e2eMs: 100, llmMs: 80, mcpMs: 20 }],
        tokens: { total: 15, input: 10, output: 5 },
        prompts: [pr],
        retryCount: 0,
      };
    }

    function createMockRunResult(count: number): EvalRunResult {
      const iterations = Array.from({ length: count }, (_, i) =>
        createMockIterationResult(i % 2 === 0)
      );

      return {
        iterations: count,
        successes: iterations.filter((i) => i.passed).length,
        failures: iterations.filter((i) => !i.passed).length,
        results: iterations.map((i) => i.passed),
        iterationDetails: iterations,
        tokenUsage: {
          total: 15 * count,
          input: 10 * count,
          output: 5 * count,
          perIteration: iterations.map((i) => i.tokens),
        },
        latency: {
          e2e: { min: 100, max: 100, mean: 100, p50: 100, p95: 100, count },
          llm: { min: 80, max: 80, mean: 80, p50: 80, p95: 80, count },
          mcp: { min: 20, max: 20, mean: 20, p50: 20, p95: 20, count },
          perIteration: iterations.flatMap((i) => i.latencies),
        },
      };
    }

    it("recordFromRun adds results and tracks count", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        okResponse({
          suiteId: "suite_1",
          runId: "run_1",
          status: "running",
          result: "pending",
        })
      );
      global.fetch = fetchMock as any;

      const reporter = createEvalRunReporter({
        apiKey: "sk_test_key",
        baseUrl: "https://example.com",
        suiteName: "record-run-test",
      });

      const run = createMockRunResult(3);
      await reporter.recordFromRun(run, { casePrefix: "test-case" });
      expect(reporter.getAddedCount()).toBe(3);
    });

    it("recordFromSuiteRun adds results and tracks count", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        okResponse({
          suiteId: "suite_1",
          runId: "run_1",
          status: "running",
          result: "pending",
        })
      );
      global.fetch = fetchMock as any;

      const reporter = createEvalRunReporter({
        apiKey: "sk_test_key",
        baseUrl: "https://example.com",
        suiteName: "record-suite-test",
      });

      const suiteRun = new Map<string, EvalRunResult>();
      suiteRun.set("test-a", createMockRunResult(2));
      suiteRun.set("test-b", createMockRunResult(3));

      await reporter.recordFromSuiteRun(suiteRun, { casePrefix: "suite" });
      expect(reporter.getAddedCount()).toBe(5);
    });

    it("recordFromPrompt triggers auto-flush when buffer is large", async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          okResponse({
            suiteId: "suite_1",
            runId: "run_1",
            status: "running",
            result: "pending",
          })
        )
        .mockResolvedValue(
          okResponse({ inserted: 200, skipped: 0, total: 200 })
        );
      global.fetch = fetchMock as any;

      const reporter = createEvalRunReporter({
        apiKey: "sk_test_key",
        baseUrl: "https://example.com",
        suiteName: "autoflush-test",
      });

      // Fill the buffer to the 200-result threshold
      for (let i = 0; i < 199; i++) {
        reporter.add({ caseTitle: `case-${i}`, passed: true });
      }
      expect(reporter.getBufferedCount()).toBe(199);

      // The 200th result via record() should trigger auto-flush
      const pr = PromptResult.from({
        prompt: "test",
        messages: [{ role: "user", content: "test" }],
        text: "ok",
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        latency: { e2eMs: 0, llmMs: 0, mcpMs: 0 },
      });
      await reporter.recordFromPrompt(pr, {
        caseTitle: "flush-trigger",
        passed: true,
      });

      // Buffer should be empty after auto-flush
      expect(reporter.getBufferedCount()).toBe(0);
      expect(reporter.getAddedCount()).toBe(200);
      // fetch should have been called (startEvalRun + appendIterations)
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  describe("error capture", () => {
    it("captures once when flush falls back after a chunked upload failure", async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          okResponse({
            suiteId: "suite_1",
            runId: "run_1",
            status: "running",
            result: "pending",
          })
        )
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: "Not Found",
          json: async () => ({ ok: false, error: "Not Found" }),
        });
      global.fetch = fetchMock as any;

      const reporter = createEvalRunReporter({
        apiKey: "sk_test_key",
        baseUrl: "https://example.com",
        strict: false,
        suiteName: "flush-error",
      });

      reporter.add({ caseTitle: "case-1", passed: true });
      reporter.add({ caseTitle: "case-2", passed: false });

      await reporter.flush();

      expect(sentryMocks.captureEvalReportingFailure).toHaveBeenCalledTimes(1);
      expect(sentryMocks.captureEvalReportingFailure).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          apiKey: "sk_test_key",
          baseUrl: "https://example.com",
          bufferedCount: 2,
          entrypoint: "evalRunReporter.flush",
          resultCount: 2,
          suiteName: "flush-error",
        })
      );
    });

    it("captures once when finalize falls back after finalizeEvalRun fails", async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          okResponse({
            suiteId: "suite_1",
            runId: "run_1",
            status: "running",
            result: "pending",
          })
        )
        .mockResolvedValueOnce(
          okResponse({ inserted: 1, skipped: 0, total: 1 })
        )
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: "Not Found",
          json: async () => ({ ok: false, error: "Not Found" }),
        });
      global.fetch = fetchMock as any;

      const reporter = createEvalRunReporter({
        apiKey: "sk_test_key",
        baseUrl: "https://example.com",
        strict: false,
        suiteName: "finalize-error",
      });

      reporter.add({ caseTitle: "case-1", passed: true });
      await reporter.flush();
      const result = await reporter.finalize();

      expect(result.status).toBe("failed");
      expect(result.summary).toEqual({
        total: 1,
        passed: 1,
        failed: 0,
        passRate: 1,
      });
      expect(sentryMocks.captureEvalReportingFailure).toHaveBeenCalledTimes(1);
      expect(sentryMocks.captureEvalReportingFailure).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          apiKey: "sk_test_key",
          baseUrl: "https://example.com",
          bufferedCount: 0,
          entrypoint: "evalRunReporter.finalize",
          resultCount: 0,
          runId: "run_1",
          suiteName: "finalize-error",
        })
      );
    });
  });
});

/**
 * The streaming reporter BYPASSES `reportEvalResultsInternal` on its chunked
 * path, so the print seam has its own call sites here — a chokepoint in the
 * one-shot module alone would leave every streamed run silent.
 */
describe("run URL printing", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    __resetPrintedRunUrls();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    sentryMocks.captureEvalReportingFailure.mockClear();
    vi.restoreAllMocks();
  });

  it("prints once after finalize on the streamed path", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith("/runs/start")) {
        return Promise.resolve(
          okResponse({
            suiteId: "suite_stream",
            runId: "run_stream",
            projectId: "proj_stream",
          })
        );
      }
      if (String(url).endsWith("/runs/iterations")) {
        return Promise.resolve(
          okResponse({ inserted: 1, skipped: 0, total: 1 })
        );
      }
      return Promise.resolve(
        okResponse({
          suiteId: "suite_stream",
          runId: "run_stream",
          projectId: "proj_stream",
          status: "completed",
          result: "passed",
          summary: successSummary,
        })
      );
    }) as any;

    const reporter = createEvalRunReporter({
      apiKey: "sk_test_key",
      // Pinned, like every other case in this file: `resolveBaseUrl` prefers
      // MCPJAM_BASE_URL, so asserting the default origin without this breaks
      // in any environment that sets it.
      baseUrl: "https://app.mcpjam.com",
      suiteName: "streamed",
    });
    reporter.add({ caseTitle: "case-1", passed: true });
    await reporter.flush();
    await reporter.finalize();

    const lines = logSpy.mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual([
      "[mcpjam/sdk] View run: https://app.mcpjam.com/evals/suite/suite_stream/runs/run_stream?project=proj_stream",
    ]);
  });

  it("prints nothing for the local fallback, which has no server-side run", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // Non-strict: the upload fails, `finalize` returns locally-computed
    // counts with EMPTY ids. A URL built from those would 404.
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as any;

    const reporter = createEvalRunReporter({
      apiKey: "sk_test_key",
      baseUrl: "https://app.mcpjam.com",
      suiteName: "offline",
      strict: false,
    });
    reporter.add({ caseTitle: "case-1", passed: true });
    const result = await reporter.finalize();

    expect(result.runId).toBe("");
    expect(logSpy.mock.calls.map((call) => String(call[0]))).toEqual([]);
  });
});
