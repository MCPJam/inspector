import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Covers the v1 WRITE surface: tools/call + prompts/get schema validation,
// the async eval-run POST (mocked prepare/execute seam), the eval read
// proxies (mocked ConvexHttpClient), and the OAuth import-tokens proxy.

const {
  validateGuestTokenMock,
  prepareEvalRunMock,
  createAuthorizedManagerMock,
  convexQueryMock,
  convexActionMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  prepareEvalRunMock: vi.fn(),
  createAuthorizedManagerMock: vi.fn(),
  convexQueryMock: vi.fn(),
  convexActionMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("../../shared/evals.js", async () => {
  const actual = await vi.importActual<typeof import("../../shared/evals.js")>(
    "../../shared/evals.js"
  );
  return { ...actual, prepareEvalRun: prepareEvalRunMock };
});

vi.mock("../../web/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../web/auth.js")>(
    "../../web/auth.js"
  );
  return { ...actual, createAuthorizedManager: createAuthorizedManagerMock };
});

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
    action: convexActionMock,
  })),
}));

import v1Routes from "../index.js";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function request(
  app: Hono,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );
}

const RUN_DOC = {
  _id: "run_1",
  suiteId: "suite_1",
  projectId: "p1",
  runNumber: 3,
  status: "completed",
  result: "passed",
  summary: { total: 2, passed: 2, failed: 0, passRate: 1 },
  source: "api",
  createdAt: 1,
  completedAt: 2,
};

describe("v1 write routes", () => {
  const originalEnv = {
    CONVEX_URL: process.env.CONVEX_URL,
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
  };
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
  });

  describe("tools/call and prompts/get validation", () => {
    it("rejects tools/call without toolName (400 VALIDATION_ERROR)", async () => {
      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/servers/s1/tools/call",
        { parameters: {} }
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "VALIDATION_ERROR"
      );
    });

    it("rejects prompts/get without promptName (400 VALIDATION_ERROR)", async () => {
      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/servers/s1/prompts/get",
        {}
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "VALIDATION_ERROR"
      );
    });
  });

  describe("POST /eval-runs", () => {
    it("rejects a body with neither suiteId nor tests (400)", async () => {
      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-runs",
        { serverIds: ["s1"] }
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string; message?: string };
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(prepareEvalRunMock).not.toHaveBeenCalled();
    });

    it("responds 202 with runId and detaches execution", async () => {
      const disconnectAllServers = vi.fn().mockResolvedValue(undefined);
      createAuthorizedManagerMock.mockResolvedValue({
        manager: { disconnectAllServers },
        oauthServerUrls: {},
        authenticatedUserId: null,
      });
      let resolveExecute!: () => void;
      const executeGate = new Promise<void>((resolve) => {
        resolveExecute = resolve;
      });
      prepareEvalRunMock.mockResolvedValue({
        suiteId: "suite_1",
        runId: "run_1",
        caseUpsert: { committed: [{ name: "case" }], failed: [] },
        recorder: { finalize: vi.fn() },
        execute: vi.fn(() => executeGate),
      });

      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-runs",
        { suiteId: "suite_1", serverIds: ["s1"] }
      );

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({
        runId: "run_1",
        suiteId: "suite_1",
        status: "running",
        caseUpsert: { committed: [{ name: "case" }], failed: [] },
      });
      // The request resolved while execute was still pending — async run.
      expect(disconnectAllServers).not.toHaveBeenCalled();
      // prepareEvalRun received the public->internal request mapping.
      const prepareArgs = prepareEvalRunMock.mock.calls[0][1];
      expect(prepareArgs).toMatchObject({
        projectId: "p1",
        suiteRerun: true,
        source: "api",
        convexAuthToken: "tok",
      });

      resolveExecute();
      await vi.waitFor(() =>
        expect(disconnectAllServers).toHaveBeenCalledTimes(1)
      );
    });

    it("marks the run failed when detached execution rejects", async () => {
      const disconnectAllServers = vi.fn().mockResolvedValue(undefined);
      const finalize = vi.fn().mockResolvedValue(undefined);
      createAuthorizedManagerMock.mockResolvedValue({
        manager: { disconnectAllServers },
        oauthServerUrls: {},
        authenticatedUserId: null,
      });
      prepareEvalRunMock.mockResolvedValue({
        suiteId: "suite_1",
        runId: "run_1",
        caseUpsert: { committed: [], failed: [] },
        recorder: { finalize },
        execute: vi.fn().mockRejectedValue(new Error("provider exploded")),
      });

      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-runs",
        { suiteId: "suite_1", serverIds: ["s1"] }
      );
      expect(res.status).toBe(202);
      await vi.waitFor(() => expect(finalize).toHaveBeenCalledTimes(1));
      expect(finalize).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed" })
      );
      expect(disconnectAllServers).toHaveBeenCalledTimes(1);
    });

    it("disconnects and rethrows when prepare fails (no orphan manager)", async () => {
      const disconnectAllServers = vi.fn().mockResolvedValue(undefined);
      createAuthorizedManagerMock.mockResolvedValue({
        manager: { disconnectAllServers },
        oauthServerUrls: {},
        authenticatedUserId: null,
      });
      prepareEvalRunMock.mockRejectedValue(new Error("quota exceeded"));

      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-runs",
        { suiteId: "suite_1", serverIds: ["s1"] }
      );
      expect(res.status).toBe(500);
      expect(disconnectAllServers).toHaveBeenCalledTimes(1);
    });
  });

  describe("eval read proxies", () => {
    it("returns the run DTO for a project-matched run", async () => {
      convexQueryMock.mockResolvedValueOnce(RUN_DOC);
      const res = await request(
        makeApp(),
        "GET",
        "/api/v1/projects/p1/eval-runs/run_1"
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        id: "run_1",
        suiteId: "suite_1",
        runNumber: 3,
        status: "completed",
        result: "passed",
        summary: { total: 2, passed: 2, failed: 0, passRate: 1 },
        source: "api",
        notes: null,
        createdAt: 1,
        completedAt: 2,
      });
    });

    it("404s when the run belongs to a different project", async () => {
      convexQueryMock.mockResolvedValueOnce({ ...RUN_DOC, projectId: "p2" });
      const res = await request(
        makeApp(),
        "GET",
        "/api/v1/projects/p1/eval-runs/run_1"
      );
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code?: string }).code).toBe("NOT_FOUND");
    });

    it("404s when Convex reports the run as not visible", async () => {
      convexQueryMock.mockRejectedValueOnce(
        new Error("Test suite run not found or unauthorized")
      );
      const res = await request(
        makeApp(),
        "GET",
        "/api/v1/projects/p1/eval-runs/run_1"
      );
      expect(res.status).toBe(404);
    });

    it("maps iterations onto the page envelope with usage and latency", async () => {
      convexQueryMock
        .mockResolvedValueOnce(RUN_DOC)
        .mockResolvedValueOnce({
          page: [
            {
              _id: "iter_1",
              testCaseId: "case_1",
              suiteRunId: "run_1",
              iterationNumber: 1,
              status: "completed",
              result: "passed",
              startedAt: 100,
              updatedAt: 5330,
              tokensUsed: 1342,
              usage: { inputTokens: 1100, outputTokens: 242 },
              actualToolCalls: [{ toolName: "echo", arguments: { a: 1 } }],
              testCaseSnapshot: {
                title: "case",
                model: "m",
                provider: "anthropic",
                expectedToolCalls: [{ toolName: "echo" }],
              },
            },
          ],
          isDone: false,
          continueCursor: "cursor_2",
        });

      const res = await request(
        makeApp(),
        "GET",
        "/api/v1/projects/p1/eval-runs/run_1/iterations?limit=1"
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<Record<string, unknown>>;
        nextCursor?: string;
      };
      expect(body.nextCursor).toBe("cursor_2");
      expect(body.items[0]).toMatchObject({
        id: "iter_1",
        title: "case",
        model: "m",
        provider: "anthropic",
        durationMs: 5230,
        tokensUsed: 1342,
        usage: { inputTokens: 1100, outputTokens: 242 },
        actualToolCalls: [{ toolName: "echo", arguments: { a: 1 } }],
      });
    });

    it("returns the trace blob and 404s with TRACE_NOT_AVAILABLE when missing", async () => {
      convexQueryMock
        .mockResolvedValueOnce(RUN_DOC)
        .mockResolvedValueOnce({ _id: "iter_1", suiteRunId: "run_1" });
      convexActionMock.mockResolvedValueOnce(null);
      const res = await request(
        makeApp(),
        "GET",
        "/api/v1/projects/p1/eval-runs/run_1/iterations/iter_1/trace"
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        code: "NOT_FOUND",
        details: { reason: "TRACE_NOT_AVAILABLE" },
      });
    });
  });

  describe("POST oauth/import-tokens", () => {
    it("forwards to Convex and returns { imported: true }", async () => {
      global.fetch = vi.fn(async (input: any) => {
        expect(String(input)).toBe(
          "https://convex-http.example.com/web/oauth/import-tokens"
        );
        return new Response(JSON.stringify({ expiresAt: 123 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/servers/s1/oauth/import-tokens",
        {
          serverUrl: "https://server.example.com/mcp",
          tokens: { access_token: "at", refresh_token: "rt" },
        }
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ imported: true, expiresAt: 123 });
      const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, RequestInit];
      const forwarded = JSON.parse(String(init.body));
      // Path params win over the body; kind pinned to generic.
      expect(forwarded).toMatchObject({
        projectId: "p1",
        serverId: "s1",
        kind: "generic",
        tokens: { access_token: "at" },
      });
    });

    it("rejects a body without tokens (400 VALIDATION_ERROR)", async () => {
      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/servers/s1/oauth/import-tokens",
        { serverUrl: "https://server.example.com/mcp" }
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "VALIDATION_ERROR"
      );
    });
  });
});
