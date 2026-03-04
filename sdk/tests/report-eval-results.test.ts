import {
  reportEvalResults,
  reportEvalResultsSafely,
} from "../src/report-eval-results";

const successSummary = {
  total: 1,
  passed: 1,
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

function errorResponse(status: number, message: string): any {
  return {
    ok: false,
    status,
    statusText: "Error",
    json: async () => ({ ok: false, error: message }),
  };
}

describe("reportEvalResults", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("uses one-shot /report for small payloads", async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      okResponse({
        suiteId: "suite_1",
        runId: "run_1",
        status: "completed",
        result: "passed",
        summary: successSummary,
      })
    );
    global.fetch = fetchMock as any;

    const result = await reportEvalResults({
      apiKey: "mcpjam_test_key",
      baseUrl: "https://example.com",
      suiteName: "SDK smoke",
      results: [{ caseTitle: "happy-path", passed: true }],
    });

    expect(result.runId).toBe("run_1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://example.com/sdk/v1/evals/report");
  });

  it("uses chunked flow when payload exceeds one-shot thresholds", async () => {
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
      .mockResolvedValueOnce(okResponse({ inserted: 200, skipped: 0, total: 200 }))
      .mockResolvedValueOnce(okResponse({ inserted: 1, skipped: 0, total: 1 }))
      .mockResolvedValueOnce(
        okResponse({
          suiteId: "suite_1",
          runId: "run_1",
          status: "completed",
          result: "passed",
          summary: {
            total: 201,
            passed: 201,
            failed: 0,
            passRate: 1,
          },
        })
      );
    global.fetch = fetchMock as any;

    const results = Array.from({ length: 201 }, (_, index) => ({
      caseTitle: `case-${index + 1}`,
      passed: true,
    }));

    const output = await reportEvalResults({
      apiKey: "mcpjam_test_key",
      baseUrl: "https://example.com",
      suiteName: "chunked",
      results,
    });

    expect(output.summary.total).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0][0]).toBe("https://example.com/sdk/v1/evals/runs/start");
    expect(fetchMock.mock.calls[3][0]).toBe(
      "https://example.com/sdk/v1/evals/runs/finalize"
    );
  });

  it("returns null in safe mode when strict is false", async () => {
    const fetchMock = jest.fn().mockResolvedValue(errorResponse(500, "backend down"));
    global.fetch = fetchMock as any;
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const output = await reportEvalResultsSafely({
      apiKey: "mcpjam_test_key",
      baseUrl: "https://example.com",
      suiteName: "safe-mode",
      strict: false,
      results: [{ caseTitle: "case-1", passed: true }],
    });

    expect(output).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });
});
