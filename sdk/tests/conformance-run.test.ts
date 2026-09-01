import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildConformanceRunReport,
  normalizeConformanceSuites,
} from "../src/conformance-run-types.js";
import {
  detectConformanceCiMetadata,
  githubActionExternalRunId,
} from "../src/conformance-ci.js";
import {
  isConformanceReportingConfigured,
  reportConformanceRunSafely,
} from "../src/report-conformance-run.js";
import { runConformance } from "../src/conformance-run.js";

describe("conformance run bundle", () => {
  it("defaults to protocol, apps, and tasks and ignores unknown suites", () => {
    expect(normalizeConformanceSuites(undefined)).toEqual([
      "protocol",
      "apps",
      "tasks",
    ]);
    expect(
      normalizeConformanceSuites(["oauth", "protocol", "oauth", "nope"])
    ).toEqual(["oauth", "protocol"]);
  });

  it("pools missing requested suites as incomplete, not failed", () => {
    const report = buildConformanceRunReport({
      requestedSuites: ["protocol", "apps"],
      reports: {
        protocol: {
          schemaVersion: 1,
          kind: "protocol-conformance",
          name: "protocol",
          passed: true,
          outcome: "passed",
          score: {
            score: 100,
            outcome: "passed",
            applicable: 1,
            passed: 1,
            failed: 0,
            couldNotRun: 0,
            notApplicable: 0,
            advisories: [],
            advicePointsLost: 0,
          },
          groups: [],
        },
      },
      startedAt: Date.now() - 10,
    });
    expect(report.outcome).toBe("incomplete");
    expect(report.score.couldNotRun).toBeGreaterThan(0);
  });

  it("detects GitHub Actions metadata and an idempotent external run id", () => {
    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "acme/widgets",
      GITHUB_SHA: "abc123def",
      GITHUB_REF_NAME: "feature",
      GITHUB_REF: "refs/pull/12/merge",
      GITHUB_WORKFLOW: "conformance",
      GITHUB_JOB: "check",
      GITHUB_RUN_ID: "99",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_SERVER_URL: "https://github.com",
    } as NodeJS.ProcessEnv;
    expect(detectConformanceCiMetadata(env)).toEqual({
      provider: "github_actions",
      repository: "acme/widgets",
      commitSha: "abc123def",
      branch: "feature",
      pullRequestNumber: 12,
      workflow: "conformance",
      job: "check",
      runUrl: "https://github.com/acme/widgets/actions/runs/99",
      runId: "99.2",
    });
    expect(githubActionExternalRunId(env)).toBe("gha:99:check:2");
    expect(
      detectConformanceCiMetadata({
        ...env,
        GITHUB_SERVER_URL: "https://github.com/",
      })?.runUrl
    ).toBe("https://github.com/acme/widgets/actions/runs/99");
    expect(detectConformanceCiMetadata({})).toBeUndefined();
  });

  it("enters the protocol suite from an MCPServerConfig without a protocolVersion", async () => {
    // Regression: the protocol case spread `server` (which has `url`) into
    // MCPConformanceConfig (which needs `serverUrl`), so every hosted protocol
    // run died in normalization with "Cannot read properties of undefined
    // (reading 'trim')" and was recorded as a bare could-not-run skip. The
    // suite must reach the server and settle like apps/tasks do — here every
    // request answers 401, mirroring an OAuth-protected target.
    const originalFetch = global.fetch;
    global.fetch = vi.fn(
      async () => new Response("Unauthorized", { status: 401 })
    ) as never;
    try {
      const events: Array<{ status: string; error?: string }> = [];
      const report = await runConformance({
        server: { url: "http://127.0.0.1:65535/mcp" },
        suites: ["protocol"],
        protocol: { checkIds: ["server-initialize"], checkTimeout: 2_000 },
        onProgress: (event) => {
          events.push({ status: event.status, error: event.error });
        },
      });
      for (const event of events) {
        expect(event.error ?? "").not.toMatch(/reading 'trim'/);
      }
      expect(events.some((event) => event.status === "failed")).toBe(false);
      const protocol = report.reports.protocol;
      expect(protocol).toBeDefined();
      const cases = protocol!.groups.flatMap((group) => group.cases);
      expect(cases.length).toBeGreaterThan(0);
      // The auth failure is reported as a check verdict with JSON-safe
      // details, never as a suite crash.
      expect(() => JSON.stringify(report)).not.toThrow();
      for (const reportCase of cases) {
        expect(reportCase.error ?? "").not.toMatch(/reading 'trim'/);
      }
    } finally {
      global.fetch = originalFetch;
    }
  }, 30_000);

  it("throws when OAuth is requested without a strategy config", async () => {
    await expect(
      runConformance({
        server: { url: "https://example.com/mcp" },
        suites: ["oauth"],
      })
    ).rejects.toThrow(/OAuth is opt-in/);
  });
});

describe("conformance run reporter", () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("is configured only when an API key is present", () => {
    delete process.env.MCPJAM_API_KEY;
    expect(isConformanceReportingConfigured()).toBe(false);
    expect(isConformanceReportingConfigured({ apiKey: "sk_test" })).toBe(true);
  });

  it("files a CLI run inside GitHub Actions as CI, with a re-run-stable id", async () => {
    // `defaultSource` is the caller naming ITSELF. The environment still wins,
    // or a CLI invocation from a workflow would upload as a plain local run:
    // wrong source facet, and — because the idempotent external run id is
    // derived only for CI — a duplicate history row on every re-run.
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_RUN_ID = "42";
    process.env.GITHUB_RUN_ATTEMPT = "2";
    process.env.GITHUB_JOB = "conformance";
    process.env.GITHUB_REPOSITORY = "MCPJam/inspector";

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, runId: "run_ci" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    global.fetch = fetchMock as never;

    const { startConformanceRun } = await import(
      "../src/report-conformance-run.js"
    );
    await startConformanceRun(
      { requestedSuites: ["protocol"] },
      {
        apiKey: "sk_test",
        baseUrl: "https://app.example",
        defaultSource: "cli",
      }
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.source).toBe("github_action");
    expect(body.externalRunId).toBe("gha:42:conformance:2");
    expect(body.ci?.repository).toBe("MCPJam/inspector");

    // Outside CI the same call files as the CLI, not as a bare SDK run.
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_RUN_ID;
    fetchMock.mockClear();
    await startConformanceRun(
      { requestedSuites: ["protocol"] },
      {
        apiKey: "sk_test",
        baseUrl: "https://app.example",
        defaultSource: "cli",
      }
    );
    const localBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(localBody.source).toBe("cli");
    expect(localBody.externalRunId).toBeUndefined();
  });

  it("uploads start/report/finalize and does not change a safe-path failure into a throw", async () => {
    process.env.MCPJAM_API_KEY = "sk_test";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            runId: "run_1",
            runUrl: "https://app.mcpjam.com/conformance/runs/run_1",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, runId: "run_1", outcome: "passed" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        )
      );
    global.fetch = fetchMock as never;

    const report = buildConformanceRunReport({
      requestedSuites: ["protocol"],
      reports: {
        protocol: {
          schemaVersion: 1,
          kind: "protocol-conformance",
          name: "protocol",
          passed: true,
          outcome: "passed",
          score: {
            score: 100,
            outcome: "passed",
            applicable: 1,
            passed: 1,
            failed: 0,
            couldNotRun: 0,
            notApplicable: 0,
            advisories: [],
            advicePointsLost: 0,
          },
          groups: [],
        },
      },
      startedAt: Date.now(),
    });

    const { reportConformanceRun } = await import(
      "../src/report-conformance-run.js"
    );
    const uploaded = await reportConformanceRun(report, {
      apiKey: "sk_test",
      baseUrl: "https://app.example",
      serverUrl: "https://mcp.example/mcp",
    });
    expect(uploaded.runId).toBe("run_1");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/api/v1/projects/default/conformance-ingest/runs/start"
    );
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain(
      "/api/v1/projects/default/conformance-ingest/runs/heartbeat"
    );

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error("network down"));
    const stderr: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const safe = await reportConformanceRunSafely(report, {
        apiKey: "sk_test",
        baseUrl: "https://app.example",
      });
      expect(safe).toBeNull();
      expect(stderr.join("")).toMatch(/conformance upload failed/);
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});
