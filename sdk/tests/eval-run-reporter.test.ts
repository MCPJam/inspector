const mockCaptureEvalReportingFailure = jest.fn().mockResolvedValue(undefined);

jest.mock("../src/sentry", () => ({
  captureEvalReportingFailure: mockCaptureEvalReportingFailure,
}));

import { createEvalRunReporter } from "../src/eval-run-reporter";
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
    mockCaptureEvalReportingFailure.mockClear();
    jest.restoreAllMocks();
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
      apiKey: "mcpjam_test_key",
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

  describe("getAddedCount", () => {
    it("tracks total added results", () => {
      const reporter = createEvalRunReporter({
        apiKey: "mcpjam_test_key",
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
        apiKey: "mcpjam_test_key",
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
        apiKey: "mcpjam_test_key",
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
        apiKey: "mcpjam_test_key",
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
        apiKey: "mcpjam_test_key",
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
        apiKey: "mcpjam_test_key",
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
      const fetchMock = jest.fn().mockResolvedValue(
        okResponse({
          suiteId: "suite_1",
          runId: "run_1",
          status: "running",
          result: "pending",
        })
      );
      global.fetch = fetchMock as any;

      const reporter = createEvalRunReporter({
        apiKey: "mcpjam_test_key",
        baseUrl: "https://example.com",
        suiteName: "record-run-test",
      });

      const run = createMockRunResult(3);
      await reporter.recordFromRun(run, { casePrefix: "test-case" });
      expect(reporter.getAddedCount()).toBe(3);
    });

    it("recordFromSuiteRun adds results and tracks count", async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        okResponse({
          suiteId: "suite_1",
          runId: "run_1",
          status: "running",
          result: "pending",
        })
      );
      global.fetch = fetchMock as any;

      const reporter = createEvalRunReporter({
        apiKey: "mcpjam_test_key",
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
        apiKey: "mcpjam_test_key",
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
        apiKey: "mcpjam_test_key",
        baseUrl: "https://example.com",
        strict: false,
        suiteName: "flush-error",
      });

      reporter.add({ caseTitle: "case-1", passed: true });
      reporter.add({ caseTitle: "case-2", passed: false });

      await reporter.flush();

      expect(mockCaptureEvalReportingFailure).toHaveBeenCalledTimes(1);
      expect(mockCaptureEvalReportingFailure).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          apiKey: "mcpjam_test_key",
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
        .mockResolvedValueOnce(okResponse({ inserted: 1, skipped: 0, total: 1 }))
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: "Not Found",
          json: async () => ({ ok: false, error: "Not Found" }),
        });
      global.fetch = fetchMock as any;

      const reporter = createEvalRunReporter({
        apiKey: "mcpjam_test_key",
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
      expect(mockCaptureEvalReportingFailure).toHaveBeenCalledTimes(1);
      expect(mockCaptureEvalReportingFailure).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          apiKey: "mcpjam_test_key",
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
