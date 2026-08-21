import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildConformanceRunReport,
  detectConformanceCiMetadata,
  githubActionExternalRunId,
  isConformanceReportingConfigured,
  normalizeConformanceSuites,
  reportConformanceRunSafely,
  runConformance,
} from "../src/index.js";

describe("conformance run bundle", () => {
  it("defaults to protocol, apps, and tasks and ignores unknown suites", () => {
    expect(normalizeConformanceSuites(undefined)).toEqual([
      "protocol",
      "apps",
      "tasks",
    ]);
    expect(normalizeConformanceSuites(["oauth", "protocol", "oauth", "nope"])).toEqual([
      "oauth",
      "protocol",
    ]);
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
            advisoryCount: 0,
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
    expect(detectConformanceCiMetadata({})).toBeUndefined();
  });

  it("throws when OAuth is requested without a strategy config", async () => {
    await expect(
      runConformance({
        server: { url: "https://example.com/mcp" },
        suites: ["oauth"],
      }),
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

  it("uploads start/report/finalize and does not change a safe-path failure into a throw", async () => {
    process.env.MCPJAM_API_KEY = "sk_test";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, runId: "run_1", runUrl: "https://app.mcpjam.com/conformance/runs/run_1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, runId: "run_1", outcome: "passed" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
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
            advisoryCount: 0,
            advicePointsLost: 0,
          },
          groups: [],
        },
      },
      startedAt: Date.now(),
    });

    const { reportConformanceRun } = await import("../src/report-conformance-run.js");
    const uploaded = await reportConformanceRun(report, {
      apiKey: "sk_test",
      baseUrl: "https://app.example",
      serverUrl: "https://mcp.example/mcp",
    });
    expect(uploaded.runId).toBe("run_1");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/api/v1/projects/default/conformance-ingest/runs/start",
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
