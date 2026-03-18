const mockAddBreadcrumb = jest.fn().mockResolvedValue(undefined);
const mockCaptureEvalReportingFailure = jest.fn().mockResolvedValue(undefined);

jest.mock("../src/sentry", () => ({
  addBreadcrumb: mockAddBreadcrumb,
  captureEvalReportingFailure: mockCaptureEvalReportingFailure,
}));

import {
  reportEvalResults,
  reportEvalResultsSafely,
} from "../src/report-eval-results";
import { EvalReportingError } from "../src/errors";

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
  const originalMcpjamBaseUrl = process.env.MCPJAM_BASE_URL;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalMcpjamBaseUrl === undefined) {
      delete process.env.MCPJAM_BASE_URL;
    } else {
      process.env.MCPJAM_BASE_URL = originalMcpjamBaseUrl;
    }
    mockAddBreadcrumb.mockClear();
    mockCaptureEvalReportingFailure.mockClear();
    jest.restoreAllMocks();
  });

  it("uses sdk.mcpjam.com when no baseUrl override is provided", async () => {
    delete process.env.MCPJAM_BASE_URL;

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

    await reportEvalResults({
      apiKey: "mcpjam_test_key",
      suiteName: "SDK smoke",
      results: [{ caseTitle: "happy-path", passed: true }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://sdk.mcpjam.com/sdk/v1/evals/report"
    );
  });

  it("uses MCPJAM_BASE_URL when no baseUrl override is provided", async () => {
    process.env.MCPJAM_BASE_URL = "https://tough-cassowary-291.convex.site";

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

    await reportEvalResults({
      apiKey: "mcpjam_test_key",
      suiteName: "SDK smoke",
      results: [{ caseTitle: "happy-path", passed: true }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://tough-cassowary-291.convex.site/sdk/v1/evals/report"
    );
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
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://example.com/sdk/v1/evals/report"
    );
  });

  it("adds external run and iteration ids for one-shot idempotency", async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      okResponse({
        suiteId: "suite_1",
        runId: "run_1",
        status: "completed",
        result: "passed",
        summary: {
          total: 2,
          passed: 2,
          failed: 0,
          passRate: 1,
        },
      })
    );
    global.fetch = fetchMock as any;

    await reportEvalResults({
      apiKey: "mcpjam_test_key",
      baseUrl: "https://example.com",
      suiteName: "one-shot-idempotent",
      results: [
        { caseTitle: "case-1", passed: true },
        { caseTitle: "case-2", passed: true },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(requestBody.externalRunId).toEqual(expect.any(String));
    expect(requestBody.results[0].externalIterationId).toBe(
      `${requestBody.externalRunId}-1`
    );
    expect(requestBody.results[1].externalIterationId).toBe(
      `${requestBody.externalRunId}-2`
    );
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
      .mockResolvedValueOnce(
        okResponse({ inserted: 200, skipped: 0, total: 200 })
      )
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
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://example.com/sdk/v1/evals/runs/start"
    );
    expect(fetchMock.mock.calls[3][0]).toBe(
      "https://example.com/sdk/v1/evals/runs/finalize"
    );
  });

  it("uploads widget snapshots before reporting results", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          uploadUrl: "https://upload.example.com/widget-1",
        })
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ storageId: "storage_1" }),
      })
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

    await reportEvalResults({
      apiKey: "mcpjam_test_key",
      baseUrl: "https://example.com",
      suiteName: "widget-snapshots",
      results: [
        {
          caseTitle: "happy-path",
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
              widgetHtml: "<html>cached</html>",
            },
          ],
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://example.com/sdk/v1/evals/artifacts/upload-url"
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://upload.example.com/widget-1"
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      "https://example.com/sdk/v1/evals/report"
    );

    const requestBody = JSON.parse(fetchMock.mock.calls[2][1].body as string);
    expect(requestBody.results[0].widgetSnapshots[0]).toEqual(
      expect.objectContaining({
        toolCallId: "call-1",
        widgetHtmlBlobId: "storage_1",
      })
    );
    expect(
      requestBody.results[0].widgetSnapshots[0].widgetHtml
    ).toBeUndefined();
  });

  it("warns and continues when widget snapshot upload fails", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          uploadUrl: "https://upload.example.com/widget-1",
        })
      )
      .mockResolvedValueOnce(errorResponse(400, "upload failed"))
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

    const result = await reportEvalResults({
      apiKey: "mcpjam_test_key",
      baseUrl: "https://example.com",
      suiteName: "widget-snapshots-best-effort",
      results: [
        {
          caseTitle: "happy-path",
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
              widgetHtml: "<html>cached</html>",
            },
          ],
        },
      ],
    });

    expect(result.runId).toBe("run_1");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'skipped widget snapshot upload for "create_view"'
      )
    );

    const requestBody = JSON.parse(fetchMock.mock.calls[2][1].body as string);
    expect(requestBody.results[0].widgetSnapshots).toBeUndefined();
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "eval-reporting.widget-upload",
        level: "warning",
      })
    );
    expect(mockCaptureEvalReportingFailure).not.toHaveBeenCalled();
  });

  it("wraps reporting failures in EvalReportingError and captures once", async () => {
    const fetchMock = jest.fn().mockResolvedValue(errorResponse(404, "Not Found"));
    global.fetch = fetchMock as any;

    await expect(
      reportEvalResults({
        apiKey: "mcpjam_test_key",
        baseUrl: "https://example.com",
        suiteName: "direct-failure",
        results: [{ caseTitle: "case-1", passed: true }],
      })
    ).rejects.toMatchObject({
      attemptCount: 1,
      code: "EVAL_REPORTING_ERROR",
      endpoint: "/sdk/v1/evals/report",
      statusCode: 404,
    });

    expect(mockCaptureEvalReportingFailure).toHaveBeenCalledTimes(1);
    expect(mockCaptureEvalReportingFailure).toHaveBeenCalledWith(
      expect.any(EvalReportingError),
      expect.objectContaining({
        apiKey: "mcpjam_test_key",
        baseUrl: "https://example.com",
        entrypoint: "reportEvalResults",
        framework: undefined,
        resultCount: 1,
        suiteName: "direct-failure",
      })
    );
  });

  it("returns null in safe mode when strict is false and captures once", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(errorResponse(500, "backend down"));
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
    expect(mockCaptureEvalReportingFailure).toHaveBeenCalledTimes(1);
    expect(mockCaptureEvalReportingFailure).toHaveBeenCalledWith(
      expect.any(EvalReportingError),
      expect.objectContaining({
        apiKey: "mcpjam_test_key",
        baseUrl: "https://example.com",
        entrypoint: "reportEvalResultsSafely",
        resultCount: 1,
        suiteName: "safe-mode",
      })
    );
  });
});
