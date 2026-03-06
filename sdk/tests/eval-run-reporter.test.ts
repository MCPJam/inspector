import { createEvalRunReporter } from "../src/eval-run-reporter";

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
});
