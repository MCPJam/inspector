/**
 * Durable conformance execution: what a replayed startRun must NEVER do.
 *
 * The route already mocks this module. These tests go through the real
 * executor so a reused row — including one still `queued` — cannot re-enter
 * `runConformance`. Recovery for a dead owner is heartbeat + sweep.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { createConvexClientMock, runConformanceMock } = vi.hoisted(() => ({
  createConvexClientMock: vi.fn(),
  runConformanceMock: vi.fn(),
}));

vi.mock("../evals/route-helpers.js", () => ({
  createConvexClient: (...args: unknown[]) => createConvexClientMock(...args),
}));

vi.mock("@mcpjam/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcpjam/sdk")>();
  return {
    ...actual,
    runConformance: (...args: unknown[]) => runConformanceMock(...args),
  };
});

import { executePersistedConformanceRun } from "../conformance-run-executor.js";

function convexClient(started: {
  runId: string;
  reused?: boolean;
  status?: string;
  outcome?: string | null;
}) {
  const mutation = vi.fn(async (fn: string) => {
    if (fn === "conformanceRuns:startRun") return started;
    if (fn === "conformanceRuns:finalizeRun") {
      return { outcome: "passed", score: 100 };
    }
    return {};
  });
  const action = vi.fn(async () => undefined);
  createConvexClientMock.mockReturnValue({ mutation, action });
  return { mutation, action };
}

const SERVER = { url: "https://connector.example.com/mcp" };

describe("executePersistedConformanceRun replay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runConformanceMock.mockResolvedValue({
      outcome: "passed",
      score: { score: 100 },
    });
  });

  it("does not re-enter runConformance when startRun reuses a queued row", async () => {
    const { mutation, action } = convexClient({
      runId: "run_1",
      reused: true,
      status: "queued",
    });
    const onRunStarted = vi.fn();

    const result = await executePersistedConformanceRun({
      convexToken: "tok",
      projectId: "p1",
      server: SERVER as never,
      source: "api",
      target: { kind: "server", serverId: "s1" },
      externalRunId: "api:p1:s1:k1",
      onRunStarted,
    });

    expect(result).toEqual({
      runId: "run_1",
      reused: true,
      outcome: null,
    });
    expect(onRunStarted).toHaveBeenCalledWith("run_1", {
      reused: true,
      status: "queued",
    });
    expect(runConformanceMock).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(mutation.mock.calls[0]![0]).toBe("conformanceRuns:startRun");
  });

  it("does not re-enter runConformance when startRun reuses a completed row", async () => {
    convexClient({
      runId: "run_1",
      reused: true,
      status: "completed",
      outcome: "passed",
    });

    const result = await executePersistedConformanceRun({
      convexToken: "tok",
      projectId: "p1",
      server: SERVER as never,
      source: "api",
      target: { kind: "server", serverId: "s1" },
      externalRunId: "api:p1:s1:k1",
    });

    expect(result).toEqual({
      runId: "run_1",
      reused: true,
      outcome: "passed",
    });
    expect(runConformanceMock).not.toHaveBeenCalled();
  });

  it("sanitizes report payloads at the persistence boundary", async () => {
    // A live run against an OAuth-protected server put a raw MCPAuthError
    // instance into details.errorDetails; the Convex write rejected the whole
    // FINISHED report ("is not a supported Convex type") and the failure path
    // replaced it with a could-not-run skip. The upsert must only ever see
    // plain JSON data.
    const { action } = convexClient({
      runId: "run_1",
      reused: false,
      status: "queued",
    });
    class FakeAuthError extends Error {
      readonly code = "AUTH_ERROR";
      constructor(
        message: string,
        readonly statusCode: number
      ) {
        super(message);
        this.name = "MCPAuthError";
      }
    }
    const report = {
      schemaVersion: 1,
      kind: "apps-conformance",
      name: "apps",
      passed: false,
      outcome: "failed",
      durationMs: 5,
      groups: [
        {
          id: "apps",
          title: "Apps",
          target: "",
          passed: false,
          durationMs: 5,
          cases: [
            {
              id: "ui-tools-present",
              title: "UI Tools Present",
              status: "failed",
              durationMs: 5,
              category: "tools",
              error: "HTTP 401",
              details: { errorDetails: new FakeAuthError("HTTP 401", 401) },
            },
          ],
        },
      ],
    };
    runConformanceMock.mockImplementation(
      async (config: {
        onProgress?: (event: unknown) => Promise<void>;
      }) => {
        await config.onProgress?.({
          suiteKind: "apps",
          status: "completed",
          report,
        });
        return { outcome: "failed", score: { score: 0 } };
      }
    );

    await executePersistedConformanceRun({
      convexToken: "tok",
      projectId: "p1",
      server: SERVER as never,
      suites: ["apps"],
      source: "api",
      target: { kind: "server", serverId: "s1" },
    });

    const upsert = action.mock.calls.find(
      (call) => (call as unknown[])[0] === "conformanceRuns:upsertReportAction"
    ) as unknown as
      | [string, { report: typeof report; status: string }]
      | undefined;
    expect(upsert).toBeDefined();
    expect(upsert![1].status).toBe("completed");
    const persistedDetails = upsert![1].report.groups[0]!.cases[0]!
      .details as unknown as { errorDetails: Record<string, unknown> };
    expect(persistedDetails.errorDetails).toEqual({
      name: "MCPAuthError",
      message: "HTTP 401",
      code: "AUTH_ERROR",
      statusCode: 401,
    });
    expect(Object.getPrototypeOf(persistedDetails.errorDetails)).toBe(
      Object.prototype
    );
    expect(() => JSON.stringify(upsert![1].report)).not.toThrow();
  });

  it("keeps a finished suite's verdict when its report body cannot be persisted", async () => {
    const mutation = vi.fn(async (fn: string) => {
      if (fn === "conformanceRuns:startRun") {
        return { runId: "run_1", reused: false, status: "queued" };
      }
      if (fn === "conformanceRuns:finalizeRun") {
        return { outcome: "failed", score: 37 };
      }
      return {};
    });
    const action = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Validator error: MCPAuthError {} is not a supported Convex type"
        )
      )
      .mockResolvedValue(undefined);
    createConvexClientMock.mockReturnValue({ mutation, action });

    const report = {
      schemaVersion: 1,
      kind: "apps-conformance",
      name: "apps",
      passed: false,
      outcome: "failed",
      score: { score: 37 },
      durationMs: 9,
      groups: [
        {
          id: "apps",
          title: "Apps",
          target: "",
          passed: false,
          durationMs: 9,
          cases: [],
        },
      ],
    };
    runConformanceMock.mockImplementation(
      async (config: {
        onProgress?: (event: unknown) => Promise<void>;
      }) => {
        await config.onProgress?.({
          suiteKind: "apps",
          status: "completed",
          report,
        });
        return { outcome: "failed", score: { score: 37 } };
      }
    );

    await executePersistedConformanceRun({
      convexToken: "tok",
      projectId: "p1",
      server: SERVER as never,
      suites: ["apps"],
      source: "api",
      target: { kind: "server", serverId: "s1" },
    });

    const upserts = action.mock.calls.filter(
      (call) => call[0] === "conformanceRuns:upsertReportAction"
    );
    expect(upserts).toHaveLength(2);
    const fallback = upserts[1]![1] as {
      status: string;
      report: {
        passed: boolean;
        outcome?: string;
        score?: { score: number };
        groups: Array<{ cases: Array<{ id: string; error?: string }> }>;
      };
    };
    // The verdict survives — never rewritten as a could-not-run failure.
    expect(fallback.status).toBe("completed");
    expect(fallback.report.passed).toBe(false);
    expect(fallback.report.outcome).toBe("failed");
    expect(fallback.report.score?.score).toBe(37);
    expect(fallback.report.groups[0]!.cases[0]!.id).toBe(
      "apps-report-not-persisted"
    );
    expect(fallback.report.groups[0]!.cases[0]!.error).toMatch(
      /not a supported Convex type/
    );
  });

  it("redacts an OAuth report BEFORE it reaches the write", async () => {
    // A completed OAuth run carries a live access token, a refresh token, the
    // client secret and the Authorization header of every request it made.
    // Redacting when the report is later projected into benchmark evidence
    // would mean the credentials were already at rest in `conformanceRuns` —
    // readable by every surface that reads a run, and un-recallable.
    const { action } = convexClient({
      runId: "run_1",
      reused: false,
      status: "queued",
    });
    const report = {
      schemaVersion: 1,
      kind: "oauth-conformance",
      name: "OAuth Conformance",
      passed: true,
      outcome: "passed",
      durationMs: 4,
      groups: [
        {
          id: "oauth-1",
          title: "2025-11-25/dcr",
          target: "https://connector.example.com/mcp",
          passed: true,
          durationMs: 4,
          cases: [
            {
              id: "token_request",
              title: "Token Request",
              category: "oauth",
              status: "passed",
              durationMs: 4,
              details: {
                access_token: "at-live-secret",
                client_secret: "cs-live-secret",
              },
            },
          ],
        },
      ],
    };
    runConformanceMock.mockImplementation(
      async (config: { onProgress?: (event: unknown) => Promise<void> }) => {
        await config.onProgress?.({
          suiteKind: "oauth",
          status: "completed",
          report,
        });
        return { outcome: "passed", score: { score: 100 } };
      }
    );

    await executePersistedConformanceRun({
      convexToken: "tok",
      projectId: "p1",
      server: SERVER as never,
      suites: ["oauth"],
      source: "benchmark",
      target: { kind: "server", serverId: "s1" },
      oauth: { serverUrl: SERVER.url } as never,
    });

    const upsert = action.mock.calls.find(
      (call) => (call as unknown[])[0] === "conformanceRuns:upsertReportAction"
    ) as unknown as [string, { report: typeof report }];
    const persisted = JSON.stringify(upsert[1].report);
    expect(persisted).not.toContain("at-live-secret");
    expect(persisted).not.toContain("cs-live-secret");
  });

  it("grades an OAuth report against the pinned headless scope before writing it", async () => {
    const { action } = convexClient({
      runId: "run_1",
      reused: false,
      status: "queued",
    });
    runConformanceMock.mockImplementation(
      async (config: { onProgress?: (event: unknown) => Promise<void> }) => {
        await config.onProgress?.({
          suiteKind: "oauth",
          status: "completed",
          report: {
            schemaVersion: 1,
            kind: "oauth-conformance",
            name: "OAuth Conformance",
            passed: true,
            outcome: "passed",
            durationMs: 4,
            groups: [
              {
                id: "oauth-1",
                title: "2025-11-25/dcr",
                target: SERVER.url,
                passed: true,
                durationMs: 4,
                cases: [
                  {
                    id: "oauth_unauthenticated_challenge",
                    title: "challenge",
                    category: "oauth",
                    status: "passed",
                    durationMs: 1,
                  },
                ],
              },
            ],
          },
        });
        return { outcome: "passed", score: { score: 100 } };
      }
    );

    await executePersistedConformanceRun({
      convexToken: "tok",
      projectId: "p1",
      server: SERVER as never,
      suites: ["oauth"],
      source: "benchmark",
      target: { kind: "server", serverId: "s1" },
      oauth: { serverUrl: SERVER.url } as never,
      oauthHeadlessCheckIds: [
        "oauth_unauthenticated_challenge",
        "received_authorization_code",
      ],
    });

    const upsert = action.mock.calls.find(
      (call) => (call as unknown[])[0] === "conformanceRuns:upsertReportAction"
    ) as unknown as [
      string,
      {
        report: {
          outcome?: string;
          score?: { couldNotRun: number; applicable: number };
        };
      },
    ];
    // The pinned check the headless exam never reached is in the denominator,
    // so the run cannot read as clean.
    expect(upsert[1].report.outcome).toBe("incomplete");
    expect(upsert[1].report.score?.couldNotRun).toBe(1);
    expect(upsert[1].report.score?.applicable).toBe(2);
  });

  it("records a requested OAuth suite with no auth strategy as an explicit incomplete", async () => {
    // `runConformance` refuses a requested `oauth` suite with no config. Left
    // to it, one unconfigured suite would take the protocol/apps/tasks reports
    // down with it.
    const { action } = convexClient({
      runId: "run_1",
      reused: false,
      status: "queued",
    });

    await executePersistedConformanceRun({
      convexToken: "tok",
      projectId: "p1",
      server: SERVER as never,
      suites: ["protocol", "oauth"],
      source: "api",
      target: { kind: "server", serverId: "s1" },
    });

    expect(runConformanceMock.mock.calls[0]![0]).toMatchObject({
      suites: ["protocol"],
    });
    const oauthUpsert = action.mock.calls.find(
      (call) =>
        (call as unknown[])[0] === "conformanceRuns:upsertReportAction" &&
        ((call as unknown[])[1] as { suiteKind: string }).suiteKind === "oauth"
    ) as unknown as [string, { status: string; report: { outcome?: string } }];
    expect(oauthUpsert[1].status).toBe("failed");
    expect(oauthUpsert[1].report.outcome).toBe("incomplete");
  });

  it("forwards a configured OAuth strategy into the suite run", async () => {
    convexClient({ runId: "run_1", reused: false, status: "queued" });
    const oauth = {
      serverUrl: SERVER.url,
      protocolVersion: "2025-11-25",
      registrationStrategy: "dcr",
      auth: { mode: "headless" },
    };

    await executePersistedConformanceRun({
      convexToken: "tok",
      projectId: "p1",
      server: SERVER as never,
      suites: ["oauth"],
      source: "benchmark",
      target: { kind: "server", serverId: "s1" },
      oauth: oauth as never,
    });

    expect(runConformanceMock.mock.calls[0]![0]).toMatchObject({
      suites: ["oauth"],
      oauth,
    });
  });

  it("runs conformance for a freshly inserted row", async () => {
    const { mutation } = convexClient({
      runId: "run_1",
      reused: false,
      status: "queued",
    });

    const result = await executePersistedConformanceRun({
      convexToken: "tok",
      projectId: "p1",
      server: SERVER as never,
      suites: ["protocol"],
      source: "api",
      target: { kind: "server", serverId: "s1" },
    });

    expect(runConformanceMock).toHaveBeenCalledTimes(1);
    expect(mutation.mock.calls.map((call) => call[0])).toEqual([
      "conformanceRuns:startRun",
      "conformanceRuns:finalizeRun",
    ]);
    expect(result).toMatchObject({
      runId: "run_1",
      outcome: "passed",
      score: 100,
    });
  });
});
