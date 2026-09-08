/**
 * Canary-secret regression test for the eval reporting path (Evals v2, Lane A3).
 *
 * The premise Lane A started from — "credentials are persisted as eval data" —
 * turned out to be false. What is true is narrower and harder to see by reading
 * code: credentials legitimately transit in the ingest body, so every sink that
 * quotes something about that request is one echo away from publishing them.
 *
 * These tests plant a canary in the place a real credential lives and assert it
 * never surfaces anywhere else. They deliberately assert BOTH directions:
 * the canary must reach the request body (replay is authorized by it, and a
 * "fix" that redacts the body would silently break replay while looking like
 * hardening), and must reach nothing else.
 */

const sentryMocks = vi.hoisted(() => ({
  addBreadcrumb: vi.fn().mockResolvedValue(undefined),
  captureEvalReportingFailure: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/sentry", () => ({
  addBreadcrumb: sentryMocks.addBreadcrumb,
  captureEvalReportingFailure: sentryMocks.captureEvalReportingFailure,
}));

import {
  reportEvalResults,
  reportEvalResultsSafely,
} from "../src/report-eval-results";
import {
  renderStructuredRunHtml,
  renderStructuredRunJson,
} from "../src/structured-reporting";

/**
 * Distinctive enough that a substring search cannot collide with fixture noise,
 * and shaped like the real thing so key- and value-based redactors both engage.
 */
const CANARY = "at_canary_1a2b3c4d5e6f7g8h9i0j";
const CANARY_REFRESH = "rt_canary_9z8y7x6w5v4u3t2s1r0q";
const CANARY_CLIENT_SECRET = "cs_canary_qwertyuiopasdfghjkl";

const replayConfigs = [
  {
    serverId: "asana",
    url: "https://mcp.example.com/mcp",
    accessToken: CANARY,
    clientId: "client_public_id",
    clientSecret: CANARY_CLIENT_SECRET,
  },
];

function canaryStrings(): string[] {
  return [CANARY, CANARY_REFRESH, CANARY_CLIENT_SECRET];
}

/** Serialize anything a sink was handed, so one search covers nested shapes. */
function serializeSinkArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) {
        return `${arg.name}: ${arg.message}\n${arg.stack ?? ""}`;
      }
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join("\n");
}

function expectNoCanary(haystack: string, sinkName: string): void {
  for (const canary of canaryStrings()) {
    expect(
      haystack.includes(canary),
      `${sinkName} leaked a planted credential (${canary})`
    ).toBe(false);
  }
}

/**
 * The failure being defended against: a server that echoes the rejected request
 * back in its error string. Convex's ArgumentValidationError does exactly this,
 * so this is the realistic shape, not a contrived one.
 */
function echoingErrorResponse(body: unknown): any {
  return {
    ok: false,
    status: 400,
    statusText: "Bad Request",
    json: async () => ({
      ok: false,
      error: `ArgumentValidationError: Object contains extra field. Object: ${JSON.stringify(
        body
      )}`,
    }),
  };
}

describe("canary secret — eval reporting", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    sentryMocks.addBreadcrumb.mockClear();
    sentryMocks.captureEvalReportingFailure.mockClear();
    vi.restoreAllMocks();
  });

  it("sends the credential in the request body — replay depends on it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        ok: true,
        suiteId: "suite_1",
        runId: "run_1",
        status: "completed",
        result: "passed",
        summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
      }),
    });
    global.fetch = fetchMock as any;

    await reportEvalResults({
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      suiteName: "canary suite",
      results: [{ caseTitle: "happy-path", passed: true }],
      serverReplayConfigs: replayConfigs,
    });

    const sentBody = String(fetchMock.mock.calls[0][1].body);
    expect(sentBody).toContain(CANARY);
    expect(sentBody).toContain(CANARY_CLIENT_SECRET);
  });

  it("keeps an echoing backend error out of the thrown message, stderr and Sentry", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const fetchMock = vi
      .fn()
      .mockImplementation(async (_url, init) =>
        echoingErrorResponse(JSON.parse(String(init.body)))
      );
    global.fetch = fetchMock as any;

    // Safe mode swallows the throw and routes the message to console.warn +
    // Sentry, which is precisely the pair under test.
    await reportEvalResultsSafely({
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      suiteName: "canary suite",
      results: [{ caseTitle: "happy-path", passed: true }],
      serverReplayConfigs: replayConfigs,
    });

    expectNoCanary(
      serializeSinkArgs(warnSpy.mock.calls.flat()),
      "console.warn"
    );
    expectNoCanary(
      serializeSinkArgs(errorSpy.mock.calls.flat()),
      "console.error"
    );
    expectNoCanary(serializeSinkArgs(logSpy.mock.calls.flat()), "console.log");

    expect(sentryMocks.captureEvalReportingFailure).toHaveBeenCalled();
    expectNoCanary(
      serializeSinkArgs(
        sentryMocks.captureEvalReportingFailure.mock.calls.flat()
      ),
      "Sentry captureEvalReportingFailure"
    );
    expectNoCanary(
      serializeSinkArgs(sentryMocks.addBreadcrumb.mock.calls.flat()),
      "Sentry addBreadcrumb"
    );
  });

  it("keeps an echoing backend error out of the error surfaced to the caller", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async (_url, init) =>
        echoingErrorResponse(JSON.parse(String(init.body)))
      );
    global.fetch = fetchMock as any;

    const thrown = await reportEvalResults({
      apiKey: "sk_test_key",
      baseUrl: "https://example.com",
      suiteName: "canary suite",
      results: [{ caseTitle: "happy-path", passed: true }],
      serverReplayConfigs: replayConfigs,
    }).then(
      () => null,
      (error: unknown) => error
    );

    expect(thrown).toBeInstanceOf(Error);
    expectNoCanary(serializeSinkArgs([thrown]), "thrown EvalReportingError");
  });

  it("keeps planted credentials out of the rendered structured report", () => {
    const rendered = renderStructuredRunJson({
      // The report contract has no credential field; a leak arrives as
      // incidental payload — an error string, a captured tool result — so
      // that is what is planted here.
      summary: { total: 1, passed: 0, failed: 1, passRate: 0 },
      cases: [
        {
          name: "canary case",
          passed: false,
          error: `connection refused (authorization: Bearer ${CANARY})`,
          metadata: { accessToken: CANARY, refreshToken: CANARY_REFRESH },
        },
      ],
    } as never);

    expectNoCanary(JSON.stringify(rendered), "renderStructuredRunJson");
  });

  it("keeps planted credentials out of the rendered HTML report", () => {
    // `--out`/`--reporter` are two terminals for the same artifact
    // (`cli/src/lib/reporting.ts`), so the HTML renderer needs the identical
    // guarantee the JSON one has above: rendering from the unredacted report
    // would reopen a gap that already shipped once.
    const html = renderStructuredRunHtml({
      schemaVersion: 1,
      kind: "eval-run",
      passed: false,
      summary: {
        total: 1,
        passed: 0,
        failed: 1,
        byCategory: {
          eval: { total: 1, passed: 0, failed: 1 },
        },
      },
      cases: [
        {
          id: "case-1",
          title: "canary case",
          category: "eval",
          passed: false,
          error: `connection refused (authorization: Bearer ${CANARY})`,
          details: { accessToken: CANARY, refreshToken: CANARY_REFRESH },
        },
      ],
      durationMs: 5,
      metadata: { accessToken: CANARY, refreshToken: CANARY_REFRESH },
    } as never);

    expectNoCanary(html, "renderStructuredRunHtml");
  });
});
