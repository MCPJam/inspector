const sentryMocks = vi.hoisted(() => ({
  addBreadcrumb: vi.fn().mockResolvedValue(undefined),
  captureEvalReportingFailure: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/sentry", () => ({
  addBreadcrumb: sentryMocks.addBreadcrumb,
  captureEvalReportingFailure: sentryMocks.captureEvalReportingFailure,
}));

import {
  __resetPrintedRunUrls,
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
    sentryMocks.addBreadcrumb.mockClear();
    sentryMocks.captureEvalReportingFailure.mockClear();
    vi.restoreAllMocks();
  });

  it("uses app.mcpjam.com when no baseUrl override is provided", async () => {
    delete process.env.MCPJAM_BASE_URL;

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

    await reportEvalResults({
      apiKey: "sk_test_key",
      suiteName: "SDK smoke",
      results: [{ caseTitle: "happy-path", passed: true }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://app.mcpjam.com/api/v1/projects/default/eval-ingest/report"
    );
  });

  it("files results under an explicit project id when provided", async () => {
    delete process.env.MCPJAM_BASE_URL;
    delete process.env.MCPJAM_PROJECT_ID;

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

    await reportEvalResults({
      apiKey: "sk_test_key",
      project: "jd7abc123",
      suiteName: "SDK smoke",
      results: [{ caseTitle: "happy-path", passed: true }],
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://app.mcpjam.com/api/v1/projects/jd7abc123/eval-ingest/report"
    );
  });

  it("falls back to MCPJAM_PROJECT_ID from the environment", async () => {
    delete process.env.MCPJAM_BASE_URL;
    const prevProjectId = process.env.MCPJAM_PROJECT_ID;
    process.env.MCPJAM_PROJECT_ID = "jd7envproj";

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

    try {
      await reportEvalResults({
        apiKey: "sk_test_key",
        suiteName: "SDK smoke",
        results: [{ caseTitle: "happy-path", passed: true }],
      });
    } finally {
      if (prevProjectId === undefined) {
        delete process.env.MCPJAM_PROJECT_ID;
      } else {
        process.env.MCPJAM_PROJECT_ID = prevProjectId;
      }
    }

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://app.mcpjam.com/api/v1/projects/jd7envproj/eval-ingest/report"
    );
  });

  it("uses MCPJAM_BASE_URL when no baseUrl override is provided", async () => {
    process.env.MCPJAM_BASE_URL = "https://tough-cassowary-291.convex.site";

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

    await reportEvalResults({
      apiKey: "sk_test_key",
      suiteName: "SDK smoke",
      results: [{ caseTitle: "happy-path", passed: true }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://tough-cassowary-291.convex.site/api/v1/projects/default/eval-ingest/report"
    );
  });

  it("uses one-shot /report for small payloads", async () => {
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

    const result = await reportEvalResults({
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      suiteName: "SDK smoke",
      results: [{ caseTitle: "happy-path", passed: true }],
    });

    expect(result.runId).toBe("run_1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://example.com/api/v1/projects/default/eval-ingest/report"
    );
  });

  it("forwards serverReplayConfigs in one-shot reports", async () => {
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

    await reportEvalResults({
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      suiteName: "SDK smoke",
      serverNames: ["asana"],
      agent: {
        getServerReplayConfigs: vi.fn().mockReturnValue([
          {
            serverId: "agent",
            url: "https://agent.example.com/mcp",
            accessToken: "at_agent",
          },
        ]),
      },
      mcpClientManager: {
        getServerReplayConfigs: vi.fn().mockReturnValue([
          {
            serverId: "manager",
            url: "https://manager.example.com/mcp",
            accessToken: "at_manager",
          },
        ]),
      } as any,
      serverReplayConfigs: [
        {
          serverId: "remote",
          url: "https://example.com/mcp",
          accessToken: "at_123",
        },
      ],
      results: [{ caseTitle: "happy-path", passed: true }],
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(requestBody.serverReplayConfigs).toEqual([
      {
        serverId: "remote",
        url: "https://example.com/mcp",
        accessToken: "at_123",
      },
    ]);
  });

  it("filters inferred replay configs by serverNames in one-shot reports", async () => {
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

    await reportEvalResults({
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      suiteName: "SDK smoke",
      serverNames: ["asana"],
      agent,
      results: [{ caseTitle: "happy-path", passed: true }],
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(requestBody.serverReplayConfigs).toEqual([
      {
        serverId: "asana",
        url: "https://asana.example.com/mcp",
        accessToken: "at_asana",
      },
    ]);
  });

  it("resolves replay configs from agent in one-shot reports", async () => {
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

    await reportEvalResults({
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      suiteName: "SDK smoke",
      agent,
      results: [{ caseTitle: "happy-path", passed: true }],
    });

    expect(agent.getServerReplayConfigs).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(requestBody.serverReplayConfigs).toEqual([
      {
        serverId: "agent",
        url: "https://agent.example.com/mcp",
        accessToken: "at_agent",
      },
    ]);
  });

  it("prefers agent replay configs over mcpClientManager", async () => {
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
    const mcpClientManager = {
      getServerReplayConfigs: vi.fn().mockReturnValue([
        {
          serverId: "manager",
          url: "https://manager.example.com/mcp",
          accessToken: "at_manager",
        },
      ]),
    };

    await reportEvalResults({
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      suiteName: "SDK smoke",
      agent,
      mcpClientManager: mcpClientManager as any,
      results: [{ caseTitle: "happy-path", passed: true }],
    });

    expect(agent.getServerReplayConfigs).toHaveBeenCalledTimes(1);
    expect(mcpClientManager.getServerReplayConfigs).not.toHaveBeenCalled();
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(requestBody.serverReplayConfigs).toEqual([
      {
        serverId: "agent",
        url: "https://agent.example.com/mcp",
        accessToken: "at_agent",
      },
    ]);
  });

  it("falls back to mcpClientManager replay configs when agent has none", async () => {
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
      getServerReplayConfigs: vi.fn().mockReturnValue([]),
    };
    const mcpClientManager = {
      getServerReplayConfigs: vi.fn().mockReturnValue([
        {
          serverId: "manager",
          url: "https://manager.example.com/mcp",
          accessToken: "at_manager",
        },
      ]),
    };

    await reportEvalResults({
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      suiteName: "SDK smoke",
      agent,
      mcpClientManager: mcpClientManager as any,
      results: [{ caseTitle: "happy-path", passed: true }],
    });

    expect(agent.getServerReplayConfigs).toHaveBeenCalledTimes(1);
    expect(mcpClientManager.getServerReplayConfigs).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(requestBody.serverReplayConfigs).toEqual([
      {
        serverId: "manager",
        url: "https://manager.example.com/mcp",
        accessToken: "at_manager",
      },
    ]);
  });

  it("resolves replay configs from mcpClientManager when agent is absent", async () => {
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

    const mcpClientManager = {
      getServerReplayConfigs: vi.fn().mockReturnValue([
        {
          serverId: "manager",
          url: "https://manager.example.com/mcp",
          accessToken: "at_manager",
        },
      ]),
    };

    await reportEvalResults({
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      suiteName: "SDK smoke",
      mcpClientManager: mcpClientManager as any,
      results: [{ caseTitle: "happy-path", passed: true }],
    });

    expect(mcpClientManager.getServerReplayConfigs).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(requestBody.serverNames).toEqual(["manager"]);
    expect(requestBody.serverReplayConfigs).toEqual([
      {
        serverId: "manager",
        url: "https://manager.example.com/mcp",
        accessToken: "at_manager",
      },
    ]);
  });

  it("adds external run and iteration ids for one-shot idempotency", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
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
      apiKey: "sk_test_key",
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
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      suiteName: "chunked",
      results,
    });

    expect(output.summary.total).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://example.com/api/v1/projects/default/eval-ingest/runs/start"
    );
    expect(fetchMock.mock.calls[3][0]).toBe(
      "https://example.com/api/v1/projects/default/eval-ingest/runs/finalize"
    );
  });

  it("forwards serverReplayConfigs when starting chunked runs", async () => {
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

    const largeTrace = "x".repeat(1024 * 1024);

    await reportEvalResults({
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      suiteName: "chunked-replay",
      serverReplayConfigs: [
        {
          serverId: "remote",
          url: "https://example.com/mcp",
          refreshToken: "rt_123",
          clientId: "cid_123",
        },
      ],
      results: [{ caseTitle: "case-1", passed: true, trace: largeTrace }],
    });

    const startBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(startBody.serverNames).toEqual(["remote"]);
    expect(startBody.serverReplayConfigs).toEqual([
      {
        serverId: "remote",
        url: "https://example.com/mcp",
        refreshToken: "rt_123",
        clientId: "cid_123",
      },
    ]);
  });

  it("keeps widget evidence inline so retries have identical content before server storage", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
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
      apiKey: "sk_test_key",
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("eval-ingest/report");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.results[0].widgetSnapshots[0].widgetHtml).toBe(
      "<html>cached</html>"
    );
    expect(body.results[0].widgetSnapshots[0].widgetHtmlBlobId).toBeUndefined();
  });

  it("offloads widget evidence to storage when one result is too large to send inline", async () => {
    // Two calls of a ~600KB built app: over the 1MB body limit, and chunking
    // cannot help because it only splits between results.
    const bigWidgetHtml = `<html>${"x".repeat(600_000)}</html>`;
    const snapshot = (toolCallId: string) => ({
      toolCallId,
      toolName: "create_view",
      protocol: "mcp-apps" as const,
      serverId: "server-1",
      resourceUri: "ui://widget/create-view.html",
      toolMetadata: { ui: { resourceUri: "ui://widget/create-view.html" } },
      widgetCsp: null,
      widgetPermissions: null,
      widgetPermissive: true,
      prefersBorder: true,
      widgetHtml: bigWidgetHtml,
    });

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith("/eval-ingest/artifacts")) {
        return Promise.resolve(okResponse({ storageId: "storage_1" }));
      }
      return Promise.resolve(
        okResponse({
          suiteId: "suite_1",
          runId: "run_1",
          status: "completed",
          result: "passed",
          summary: successSummary,
        })
      );
    });
    global.fetch = fetchMock as any;

    await reportEvalResults({
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      suiteName: "widget-snapshots",
      results: [
        {
          caseTitle: "happy-path",
          passed: true,
          widgetSnapshots: [snapshot("call-1"), snapshot("call-2")],
        },
      ],
    });

    const reportCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("eval-ingest/report")
    );
    expect(reportCall).toBeDefined();
    const body = JSON.parse(reportCall![1].body);
    for (const sent of body.results[0].widgetSnapshots) {
      expect(sent.widgetHtml).toBeUndefined();
      expect(sent.widgetHtmlBlobId).toBe("storage_1");
    }
    // The raw HTML goes to the ingest API's artifacts route with the API key,
    // as text so storage never serves the widget as a page.
    const uploadCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).endsWith("/eval-ingest/artifacts")
    );
    expect(uploadCalls).toHaveLength(2);
    for (const [url, init] of uploadCalls) {
      expect(url).toBe(
        "https://example.com/api/v1/projects/default/eval-ingest/artifacts"
      );
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({
        "Content-Type": "text/plain; charset=utf-8",
        Authorization: "Bearer sk_test_key",
      });
      expect(init.body).toBe(bigWidgetHtml);
    }
    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).includes("upload-url")
      )
    ).toBe(false);
    // The point of the offload: the request now fits.
    expect(new TextEncoder().encode(reportCall![1].body).length).toBeLessThan(
      1024 * 1024
    );
  });

  it("leaves a small widget inline while offloading the oversized one beside it", async () => {
    const bigWidgetHtml = `<html>${"x".repeat(600_000)}</html>`;
    const widget = (toolCallId: string, widgetHtml: string) => ({
      toolCallId,
      toolName: "create_view",
      protocol: "mcp-apps" as const,
      serverId: "server-1",
      resourceUri: "ui://widget/create-view.html",
      toolMetadata: { ui: { resourceUri: "ui://widget/create-view.html" } },
      widgetCsp: null,
      widgetPermissions: null,
      widgetPermissive: true,
      prefersBorder: true,
      widgetHtml,
    });

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith("/eval-ingest/artifacts")) {
        return Promise.resolve(okResponse({ storageId: "storage_1" }));
      }
      return Promise.resolve(
        okResponse({
          suiteId: "suite_1",
          runId: "run_1",
          status: "completed",
          result: "passed",
          summary: successSummary,
        })
      );
    });
    global.fetch = fetchMock as any;

    await reportEvalResults({
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      suiteName: "widget-snapshots",
      results: [
        {
          caseTitle: "small-widget",
          passed: true,
          widgetSnapshots: [widget("call-1", "<html>small</html>")],
        },
        {
          caseTitle: "big-widget",
          passed: true,
          widgetSnapshots: [
            widget("call-2", bigWidgetHtml),
            widget("call-3", bigWidgetHtml),
          ],
        },
      ],
    });

    const reportCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("eval-ingest/report")
    );
    expect(reportCall).toBeDefined();
    const sent = JSON.parse(reportCall![1].body).results;
    // Order is preserved and the small case is untouched.
    expect(sent.map((result: any) => result.caseTitle)).toEqual([
      "small-widget",
      "big-widget",
    ]);
    expect(sent[0].widgetSnapshots[0].widgetHtml).toBe("<html>small</html>");
    expect(sent[0].widgetSnapshots[0].widgetHtmlBlobId).toBeUndefined();
    for (const snapshot of sent[1].widgetSnapshots) {
      expect(snapshot.widgetHtml).toBeUndefined();
      expect(snapshot.widgetHtmlBlobId).toBe("storage_1");
    }
  });

  const oversizedWidgetResult = () => {
    const bigWidgetHtml = `<html>${"x".repeat(600_000)}</html>`;
    return {
      caseTitle: "big-widget",
      passed: true,
      // Two of them: one alone still fits, so only a pair forces the offload.
      widgetSnapshots: ["call-1", "call-2"].map((toolCallId) => ({
        toolCallId,
        toolName: "create_view",
        protocol: "mcp-apps" as const,
        serverId: "server-1",
        resourceUri: "ui://widget/create-view.html",
        toolMetadata: {},
        widgetCsp: null,
        widgetPermissions: null,
        widgetPermissive: true,
        prefersBorder: true,
        widgetHtml: bigWidgetHtml,
      })),
    };
  };

  /**
   * A report of one oversized result, answered like a real ingestion
   * backend: `artifacts` by `onArtifact`, the chunked run routes with
   * well-formed acknowledgments, and the one-shot report as completed.
   */
  const mockIngestion = (onArtifact: (attempt: number) => any) => {
    let artifactAttempts = 0;
    return vi.fn().mockImplementation((url: string, init: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/eval-ingest/artifacts")) {
        artifactAttempts += 1;
        return Promise.resolve(onArtifact(artifactAttempts));
      }
      if (target.endsWith("/runs/iterations")) {
        const count = JSON.parse(init.body as string).results.length;
        return Promise.resolve(
          okResponse({ inserted: count, skipped: 0, total: count })
        );
      }
      if (target.endsWith("/runs/start")) {
        return Promise.resolve(
          okResponse({ suiteId: "suite_1", runId: "run_1" })
        );
      }
      return Promise.resolve(
        okResponse({
          suiteId: "suite_1",
          runId: "run_1",
          status: "completed",
          result: "passed",
          summary: successSummary,
        })
      );
    });
  };

  const artifactCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter((call) =>
      String(call[0]).endsWith("/eval-ingest/artifacts")
    );

  const sentWidgets = (fetchMock: ReturnType<typeof vi.fn>) => {
    const reportCall = fetchMock.mock.calls.find((call) =>
      /eval-ingest\/(report|runs\/iterations)$/.test(String(call[0]))
    );
    return JSON.parse(reportCall![1].body).results[0].widgetSnapshots;
  };

  function retryableResponse(status: number): any {
    return {
      ok: false,
      status,
      statusText: "Error",
      headers: new Headers({ "retry-after": "0" }),
      json: async () => ({ code: "RATE_LIMITED", message: "Try again" }),
    };
  }

  it("uploads widget evidence to the configured project's artifacts route", async () => {
    const fetchMock = mockIngestion(() =>
      okResponse({ storageId: "storage_1" })
    );
    global.fetch = fetchMock as any;

    await reportEvalResults({
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      project: "prj_1",
      suiteName: "widget-snapshots",
      results: [oversizedWidgetResult()],
    });

    expect(artifactCalls(fetchMock).map((call) => call[0])).toEqual([
      "https://example.com/api/v1/projects/prj_1/eval-ingest/artifacts",
      "https://example.com/api/v1/projects/prj_1/eval-ingest/artifacts",
    ]);
    for (const snapshot of sentWidgets(fetchMock)) {
      expect(snapshot.widgetHtmlBlobId).toBe("storage_1");
      expect(snapshot.widgetHtml).toBeUndefined();
    }
  });

  it.each([503, 429])(
    "retries an artifact upload answered with %i, then reports the stored id",
    async (status) => {
      const fetchMock = mockIngestion((attempt) =>
        attempt === 1
          ? retryableResponse(status)
          : okResponse({ storageId: `storage_${attempt}` })
      );
      global.fetch = fetchMock as any;

      await reportEvalResults({
        apiKey: "sk_test_key",
        baseUrl: "https://example.com",
        suiteName: "widget-snapshots",
        results: [oversizedWidgetResult()],
      });

      // First widget: refused once, stored on the retry. Second: stored.
      expect(artifactCalls(fetchMock)).toHaveLength(3);
      expect(
        sentWidgets(fetchMock).map(
          (snapshot: { widgetHtmlBlobId?: string }) => snapshot.widgetHtmlBlobId
        )
      ).toEqual(["storage_2", "storage_3"]);
      expect(
        fetchMock.mock.calls.some((call) =>
          String(call[0]).includes("upload-url")
        )
      ).toBe(false);
    }
  );

  it.each([400, 401, 403, 413])(
    "keeps the widget inline without retrying a %i artifact refusal",
    async (status) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = mockIngestion(() => errorResponse(status, "refused"));
      global.fetch = fetchMock as any;

      await reportEvalResults({
        apiKey: "sk_test_key",
        baseUrl: "https://example.com",
        suiteName: "widget-snapshots",
        results: [oversizedWidgetResult()],
      });

      // One attempt per widget, then the evidence rides inline instead.
      expect(artifactCalls(fetchMock)).toHaveLength(2);
      for (const snapshot of sentWidgets(fetchMock)) {
        expect(snapshot.widgetHtmlBlobId).toBeUndefined();
        expect(snapshot.widgetHtml).toContain("<html>");
      }
      expect(
        warn.mock.calls.some((call) =>
          String(call[0]).includes("skipped widget snapshot upload")
        )
      ).toBe(true);
    }
  );

  it("never sends an artifact over maxArtifactBytes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = mockIngestion(() =>
      okResponse({ storageId: "storage_1" })
    );
    global.fetch = fetchMock as any;

    await reportEvalResults({
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      suiteName: "widget-snapshots",
      results: [oversizedWidgetResult()],
      transport: { maxArtifactBytes: 1024 },
    });

    expect(artifactCalls(fetchMock)).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it("wraps reporting failures in EvalReportingError and captures once", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(errorResponse(404, "Not Found"));
    global.fetch = fetchMock as any;

    await expect(
      reportEvalResults({
        apiKey: "sk_test_key",
        baseUrl: "https://example.com",
        suiteName: "direct-failure",
        results: [{ caseTitle: "case-1", passed: true }],
      })
    ).rejects.toMatchObject({
      attemptCount: 1,
      code: "EVAL_REPORTING_ERROR",
      endpoint: "/api/v1/projects/default/eval-ingest/report",
      statusCode: 404,
    });

    expect(sentryMocks.captureEvalReportingFailure).toHaveBeenCalledTimes(1);
    expect(sentryMocks.captureEvalReportingFailure).toHaveBeenCalledWith(
      expect.any(EvalReportingError),
      expect.objectContaining({
        apiKey: "sk_test_key",
        baseUrl: "https://example.com",
        entrypoint: "reportEvalResults",
        framework: undefined,
        resultCount: 1,
        suiteName: "direct-failure",
      })
    );
    expect(
      sentryMocks.captureEvalReportingFailure.mock.calls[0][1]
    ).not.toHaveProperty("serverReplayConfigs");
  });

  it("prints a clean eval quota error and does not retry", async () => {
    const convexError =
      'Uncaught ConvexError: {"code":"billing_limit_reached","message":"Limit \\"maxEvalIterationsPerMonth\\" reached on the team plan.","limit":"maxEvalIterationsPerMonth","gateKey":"maxEvalIterationsPerMonth","plan":"team","source":"subscription","currentValue":5001,"allowedValue":5000,"upgradePlan":"enterprise","enforcementState":"enforcing","resetsAt":1793491200000,"windowKind":"month"}\n' +
      "    at reserveEvalIterations (../../convex/lib/tierLimits.ts:333:12)";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(errorResponse(500, convexError));
    global.fetch = fetchMock as any;

    await expect(
      reportEvalResults({
        apiKey: "sk_test_key",
        baseUrl: "https://example.com",
        suiteName: "quota-failure",
        results: [{ caseTitle: "case-1", passed: true }],
      })
    ).rejects.toMatchObject({
      message:
        "Eval iteration limit reached. Resets at 2026-11-01T00:00:00.000Z.",
      attemptCount: 1,
      code: "EVAL_REPORTING_ERROR",
      endpoint: "/api/v1/projects/default/eval-ingest/report",
      statusCode: 500,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry billing-limit errors after message normalization", async () => {
    const convexError =
      'Uncaught ConvexError: {"code":"billing_limit_reached","message":"Team plan billing limit reached.","limit":"someOtherLimit","gateKey":"someOtherLimit"}';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(errorResponse(500, convexError));
    global.fetch = fetchMock as any;

    await expect(
      reportEvalResults({
        apiKey: "sk_test_key",
        baseUrl: "https://example.com",
        suiteName: "quota-failure",
        results: [{ caseTitle: "case-1", passed: true }],
      })
    ).rejects.toMatchObject({
      message: "Team plan billing limit reached.",
      attemptCount: 1,
      code: "EVAL_REPORTING_ERROR",
      endpoint: "/api/v1/projects/default/eval-ingest/report",
      statusCode: 500,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null in safe mode when strict is false and captures once", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(errorResponse(500, "backend down"));
    global.fetch = fetchMock as any;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const output = await reportEvalResultsSafely({
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      suiteName: "safe-mode",
      strict: false,
      results: [{ caseTitle: "case-1", passed: true }],
    });

    expect(output).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    expect(sentryMocks.captureEvalReportingFailure).toHaveBeenCalledTimes(1);
    expect(sentryMocks.captureEvalReportingFailure).toHaveBeenCalledWith(
      expect.any(EvalReportingError),
      expect.objectContaining({
        apiKey: "sk_test_key",
        baseUrl: "https://example.com",
        entrypoint: "reportEvalResultsSafely",
        resultCount: 1,
        suiteName: "safe-mode",
      })
    );
    expect(
      sentryMocks.captureEvalReportingFailure.mock.calls[0][1]
    ).not.toHaveProperty("serverReplayConfigs");
  });
});

/**
 * The terminal deep link. The SDK used to upload results and say nothing
 * about where they went; these cover the seam that fixes that, including the
 * paths where it must stay QUIET.
 */
describe("printRunUrl", () => {
  const originalFetch = global.fetch;
  const originalMcpjamBaseUrl = process.env.MCPJAM_BASE_URL;
  const originalProjectId = process.env.MCPJAM_PROJECT_ID;

  beforeEach(() => {
    // The print-once guard is module-level and keyed on runId, so fixtures
    // that reuse a run id across cases would silently suppress each other.
    __resetPrintedRunUrls();
    delete process.env.MCPJAM_BASE_URL;
    delete process.env.MCPJAM_PROJECT_ID;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalMcpjamBaseUrl === undefined) delete process.env.MCPJAM_BASE_URL;
    else process.env.MCPJAM_BASE_URL = originalMcpjamBaseUrl;
    if (originalProjectId === undefined) delete process.env.MCPJAM_PROJECT_ID;
    else process.env.MCPJAM_PROJECT_ID = originalProjectId;
    sentryMocks.addBreadcrumb.mockClear();
    sentryMocks.captureEvalReportingFailure.mockClear();
    vi.restoreAllMocks();
  });

  function logLines(spy: ReturnType<typeof vi.spyOn>): string[] {
    return spy.mock.calls.map((call) => String(call[0]));
  }

  it("prints the run URL with the project the backend resolved", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue(
      okResponse({
        suiteId: "suite_print_1",
        runId: "run_print_1",
        projectId: "proj_resolved",
        status: "completed",
        result: "passed",
        summary: successSummary,
      })
    ) as any;

    await reportEvalResults({
      apiKey: "sk_test_key",
      suiteName: "printing",
      results: [{ caseTitle: "case", passed: true }],
    });

    // The public Evaluate link preserves the exact uploaded run.
    expect(logLines(logSpy)).toEqual([
      "[mcpjam/sdk] View run: https://app.mcpjam.com/evaluate/suite/suite_print_1/runs/run_print_1?project=proj_resolved",
    ]);
  });

  it("omits ?project= against a backend that does not echo projectId", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue(
      okResponse({
        suiteId: "suite_print_2",
        runId: "run_print_2",
        status: "completed",
        result: "passed",
        summary: successSummary,
      })
    ) as any;

    await reportEvalResults({
      apiKey: "sk_test_key",
      suiteName: "printing",
      results: [{ caseTitle: "case", passed: true }],
    });

    // Degrades to the app's active-project fallback rather than emitting a
    // `?project=default` that resolves to nothing.
    const [line] = logLines(logSpy);
    expect(line).toBe(
      "[mcpjam/sdk] View run: https://app.mcpjam.com/evaluate/suite/suite_print_2/runs/run_print_2"
    );
  });

  it("uses a caller-configured project when the backend is silent", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue(
      okResponse({
        suiteId: "suite_print_3",
        runId: "run_print_3",
        status: "completed",
        result: "passed",
        summary: successSummary,
      })
    ) as any;

    await reportEvalResults({
      apiKey: "sk_test_key",
      project: "jd7configured",
      suiteName: "printing",
      results: [{ caseTitle: "case", passed: true }],
    });

    expect(logLines(logSpy)[0]).toContain("?project=jd7configured");
  });

  it("prints once for a chunked upload, at finalize", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string, init: RequestInit) => {
        if (String(url).endsWith("/runs/start")) {
          return Promise.resolve(
            okResponse({
              suiteId: "suite_chunk",
              runId: "run_chunk",
              projectId: "proj_chunk",
            })
          );
        }
        if (String(url).endsWith("/runs/iterations")) {
          return Promise.resolve(
            okResponse({
              inserted: JSON.parse(init.body as string).results.length,
              skipped: 0,
              total: JSON.parse(init.body as string).results.length,
            })
          );
        }
        return Promise.resolve(
          okResponse({
            suiteId: "suite_chunk",
            runId: "run_chunk",
            projectId: "proj_chunk",
            status: "completed",
            result: "passed",
            summary: successSummary,
          })
        );
      });
    global.fetch = fetchMock as any;

    // Over the one-shot result limit, so the chunked path is taken.
    await reportEvalResults({
      apiKey: "sk_test_key",
      suiteName: "chunked",
      results: Array.from({ length: 250 }, (_, index) => ({
        caseTitle: `case-${index}`,
        passed: true,
      })),
    });

    expect(logLines(logSpy)).toEqual([
      "[mcpjam/sdk] View run: https://app.mcpjam.com/evaluate/suite/suite_chunk/runs/run_chunk?project=proj_chunk",
    ]);
  });

  it("prints once on the idempotent-reuse short-circuit (the CI-retry path)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string, init: RequestInit) => {
        if (String(url).endsWith("/runs/iterations")) {
          const count = JSON.parse(String(init.body)).results.length;
          return Promise.resolve(
            okResponse({ inserted: 0, skipped: count, total: count })
          );
        }
        if (String(url).endsWith("/runs/start")) {
          return Promise.resolve(
            okResponse({
              suiteId: "suite_reuse",
              runId: "run_reuse",
              projectId: "proj_reuse",
              reused: true,
              status: "completed",
              result: "passed",
              summary: successSummary,
            })
          );
        }
        throw new Error(`unexpected request to ${url}`);
      });
    global.fetch = fetchMock as any;

    await reportEvalResults({
      apiKey: "sk_test_key",
      suiteName: "reused",
      externalRunId: "ci-run-1",
      results: Array.from({ length: 250 }, (_, index) => ({
        caseTitle: `case-${index}`,
        passed: true,
      })),
    });

    expect(logLines(logSpy)).toEqual([
      "[mcpjam/sdk] View run: https://app.mcpjam.com/evaluate/suite/suite_reuse/runs/run_reuse?project=proj_reuse",
    ]);
  });

  it("prints nothing when the upload fails", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // 400, not 500: a retryable status makes `requestWithRetry` sleep through
    // its whole backoff ladder before this can assert. The claim under test —
    // no link on failure — holds for any failure status.
    global.fetch = vi.fn().mockResolvedValue(errorResponse(400, "boom")) as any;

    await expect(
      reportEvalResults({
        apiKey: "sk_test_key",
        suiteName: "failing",
        results: [{ caseTitle: "case", passed: true }],
      })
    ).rejects.toBeInstanceOf(EvalReportingError);

    expect(logLines(logSpy)).toEqual([]);
  });
});
