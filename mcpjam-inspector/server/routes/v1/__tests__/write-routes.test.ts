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
  validateApiKeyMock,
  resolveUserByExternalIdMock,
  lookupWorkosKeyBindingMock,
} = vi.hoisted(() => {
  // The evals route resolves its concurrency limit at import time; pin the
  // env BEFORE the hoisted imports run so a V1_MAX_CONCURRENT_EVAL_RUNS in
  // the local/CI environment can't skew the gate tests.
  process.env.V1_MAX_CONCURRENT_EVAL_RUNS = "2";
  return {
    validateGuestTokenMock: vi.fn(),
    prepareEvalRunMock: vi.fn(),
    createAuthorizedManagerMock: vi.fn(),
    convexQueryMock: vi.fn(),
    convexActionMock: vi.fn(),
    validateApiKeyMock: vi.fn(),
    resolveUserByExternalIdMock: vi.fn(),
    lookupWorkosKeyBindingMock: vi.fn(),
  };
});

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

// WorkOS API-key middleware seams — same pattern as bearer-auth.test.ts.
// Only exercised by tests that send an `sk_` bearer; JWT-bearer tests never
// reach these.
vi.mock("../../../services/workos-client.js", () => ({
  getWorkOSClient: () => ({
    apiKeys: { createValidation: validateApiKeyMock },
  }),
}));

vi.mock("../../../services/identity.js", () => ({
  resolveUserByExternalId: resolveUserByExternalIdMock,
}));

vi.mock("../../../services/workos-key-bindings.js", () => ({
  lookupWorkosKeyBinding: lookupWorkosKeyBindingMock,
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
import { parseMaxConcurrentRuns } from "../evals.js";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function request(
  app: Hono,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  token = "tok"
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
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
    INSPECTOR_SERVICE_TOKEN: process.env.INSPECTOR_SERVICE_TOKEN,
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

    describe("inline test model validation", () => {
      const inlineTest = (model: string, provider = "anthropic") => ({
        title: "echo works",
        query: "Use the echo tool to say hi",
        runs: 1,
        model,
        provider,
        expectedToolCalls: [],
      });

      function mockHappyCreate() {
        createAuthorizedManagerMock.mockResolvedValue({
          manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
          oauthServerUrls: {},
          authenticatedUserId: null,
        });
        prepareEvalRunMock.mockResolvedValue({
          suiteId: "suite_1",
          runId: "run_1",
          caseUpsert: { committed: [], failed: [] },
          recorder: { finalize: vi.fn() },
          execute: vi.fn().mockResolvedValue(undefined),
        });
      }

      it("rejects a model the API cannot execute, naming the hosted ids", async () => {
        // The exact failure mode that motivated this: a raw Anthropic API id
        // is not hosted and has no BYOK key, so the run would 202 and then
        // die with zero tokens and an opaque stream error.
        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          { suiteName: "smoke", serverIds: ["s1"], tests: [inlineTest("claude-sonnet-4-6")] }
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as {
          code?: string;
          details?: { hostedModels?: string[] };
        };
        expect(body.code).toBe("VALIDATION_ERROR");
        expect(body.details?.hostedModels).toContain(
          "anthropic/claude-haiku-4.5"
        );
        expect(prepareEvalRunMock).not.toHaveBeenCalled();
      });

      it("admits a hosted catalog id", async () => {
        mockHappyCreate();
        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          {
            suiteName: "smoke",
            serverIds: ["s1"],
            tests: [inlineTest("anthropic/claude-haiku-4.5")],
          }
        );
        expect(res.status).toBe(202);
      });

      it("admits an unknown id when the caller brings a provider key", async () => {
        mockHappyCreate();
        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          {
            suiteName: "smoke",
            serverIds: ["s1"],
            tests: [inlineTest("claude-sonnet-4-6")],
            modelApiKeys: { anthropic: "sk-ant-test" },
          }
        );
        expect(res.status).toBe(202);
      });

      it("admits a cataloged BYOK id without a caller key (org keys may cover it)", async () => {
        mockHappyCreate();
        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          {
            suiteName: "smoke",
            serverIds: ["s1"],
            tests: [inlineTest("claude-sonnet-4-5")],
          }
        );
        expect(res.status).toBe(202);
      });
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

    it("marks the run failed when detached execution rejects before the runner finalizes", async () => {
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
      // The catch's terminal-status probe sees the run still running —
      // the error escaped before the runner's own finalize.
      convexQueryMock.mockResolvedValueOnce({ ...RUN_DOC, status: "running" });

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

    it("does not re-finalize when the runner already finalized the failed run", async () => {
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
        // runEvalSuiteWithAiSdk semantics: finalize as failed, then rethrow.
        execute: vi.fn().mockRejectedValue(new Error("execution failed")),
      });
      convexQueryMock.mockResolvedValueOnce({ ...RUN_DOC, status: "failed" });

      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-runs",
        { suiteId: "suite_1", serverIds: ["s1"] }
      );
      expect(res.status).toBe(202);
      // The teardown still runs, but no second terminal write happens.
      await vi.waitFor(() =>
        expect(disconnectAllServers).toHaveBeenCalledTimes(1)
      );
      expect(finalize).not.toHaveBeenCalled();
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

    it("passes the delegated Convex JWT — not the sk_ key — to the manager for API-key callers", async () => {
      process.env.INSPECTOR_SERVICE_TOKEN = "svc_token";
      validateApiKeyMock.mockResolvedValue({
        apiKey: { id: "key_1", owner: { id: "workos_user_1" } },
      });
      resolveUserByExternalIdMock.mockResolvedValue({ _id: "convex_user_1" });
      lookupWorkosKeyBindingMock.mockResolvedValue({
        mcpjamOrganizationId: "org_1",
      });
      // The only fetch on this path is the delegated-token mint.
      global.fetch = vi.fn(async (input: any, init: any) => {
        expect(String(input)).toBe(
          "https://convex-http.example.com/web/delegated-token"
        );
        expect(init?.headers?.["x-mcpjam-acting-as"]).toBe("workos_user_1");
        expect(init?.headers?.["x-mcpjam-acting-in-org"]).toBe("org_1");
        return new Response(
          JSON.stringify({
            ok: true,
            token: "delegated-jwt",
            expiresAt: Date.now() + 2 * 60 * 60 * 1000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as typeof fetch;

      const disconnectAllServers = vi.fn().mockResolvedValue(undefined);
      createAuthorizedManagerMock.mockResolvedValue({
        manager: { disconnectAllServers },
        oauthServerUrls: {},
        authenticatedUserId: null,
      });
      prepareEvalRunMock.mockResolvedValue({
        suiteId: "suite_1",
        runId: "run_1",
        caseUpsert: { committed: [], failed: [] },
        recorder: { finalize: vi.fn() },
        execute: vi.fn().mockResolvedValue(undefined),
      });

      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-runs",
        { suiteId: "suite_1", serverIds: ["s1"] },
        "sk_live_secret"
      );
      expect(res.status).toBe(202);

      // The manager bearer feeds the hosted OAuth force-refresh closure and
      // secret reveal — both JWT-only Convex surfaces where the raw API key
      // would 401. Both seams must see the minted JWT.
      expect(createAuthorizedManagerMock.mock.calls[0][1]).toBe(
        "delegated-jwt"
      );
      expect(prepareEvalRunMock.mock.calls[0][1]).toMatchObject({
        convexAuthToken: "delegated-jwt",
        source: "api",
      });
      await vi.waitFor(() =>
        expect(disconnectAllServers).toHaveBeenCalledTimes(1)
      );
    });

    it("forces suiteRerun on a bare suiteId rerun even when the caller sends false", async () => {
      const disconnectAllServers = vi.fn().mockResolvedValue(undefined);
      createAuthorizedManagerMock.mockResolvedValue({
        manager: { disconnectAllServers },
        oauthServerUrls: {},
        authenticatedUserId: null,
      });
      prepareEvalRunMock.mockResolvedValue({
        suiteId: "suite_1",
        runId: "run_1",
        caseUpsert: { committed: [], failed: [] },
        recorder: { finalize: vi.fn() },
        execute: vi.fn().mockResolvedValue(undefined),
      });

      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-runs",
        { suiteId: "suite_1", serverIds: ["s1"], suiteRerun: false }
      );
      expect(res.status).toBe(202);
      expect(prepareEvalRunMock.mock.calls[0][1]).toMatchObject({
        suiteRerun: true,
      });
      await vi.waitFor(() =>
        expect(disconnectAllServers).toHaveBeenCalledTimes(1)
      );
    });

    it("keeps suiteRerun false when inline tests are supplied", async () => {
      const disconnectAllServers = vi.fn().mockResolvedValue(undefined);
      createAuthorizedManagerMock.mockResolvedValue({
        manager: { disconnectAllServers },
        oauthServerUrls: {},
        authenticatedUserId: null,
      });
      prepareEvalRunMock.mockResolvedValue({
        suiteId: "suite_1",
        runId: "run_1",
        caseUpsert: { committed: [], failed: [] },
        recorder: { finalize: vi.fn() },
        execute: vi.fn().mockResolvedValue(undefined),
      });

      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-runs",
        {
          suiteId: "suite_1",
          serverIds: ["s1"],
          tests: [
            {
              title: "case",
              query: "do it",
              runs: 1,
              model: "anthropic/claude-haiku-4.5",
              provider: "anthropic",
              expectedToolCalls: [],
            },
          ],
        }
      );
      expect(res.status).toBe(202);
      expect(prepareEvalRunMock.mock.calls[0][1]).toMatchObject({
        suiteRerun: false,
      });
      await vi.waitFor(() =>
        expect(disconnectAllServers).toHaveBeenCalledTimes(1)
      );
    });
  });

  describe("eval-run concurrency gate", () => {
    it("parses V1_MAX_CONCURRENT_EVAL_RUNS defensively", () => {
      expect(parseMaxConcurrentRuns(undefined)).toBe(2);
      expect(parseMaxConcurrentRuns("bad")).toBe(2); // NaN must not disable the gate
      expect(parseMaxConcurrentRuns("0")).toBe(2);
      expect(parseMaxConcurrentRuns("-3")).toBe(2);
      expect(parseMaxConcurrentRuns("2.5")).toBe(2);
      expect(parseMaxConcurrentRuns("5")).toBe(5);
    });

    it("gates a caller at the limit, isolates other bearers, and frees slots on completion", async () => {
      const app = makeApp();
      const disconnectAllServers = vi.fn().mockResolvedValue(undefined);
      createAuthorizedManagerMock.mockResolvedValue({
        manager: { disconnectAllServers },
        oauthServerUrls: {},
        authenticatedUserId: null,
      });
      const releaseGates: Array<() => void> = [];
      prepareEvalRunMock.mockImplementation(async () => ({
        suiteId: "suite_1",
        runId: "run_1",
        caseUpsert: { committed: [], failed: [] },
        recorder: { finalize: vi.fn() },
        execute: vi.fn(
          () => new Promise<void>((resolve) => releaseGates.push(resolve))
        ),
      }));
      const post = (token: string) =>
        request(
          app,
          "POST",
          "/api/v1/projects/p1/eval-runs",
          { suiteId: "suite_1", serverIds: ["s1"] },
          token
        );

      // Limit pinned to 2 by the hoisted V1_MAX_CONCURRENT_EVAL_RUNS stub.
      expect((await post("tok")).status).toBe(202);
      expect((await post("tok")).status).toBe(202);

      const gated = await post("tok");
      expect(gated.status).toBe(429);
      expect(await gated.json()).toMatchObject({
        code: "RATE_LIMITED",
        details: { reason: "CONCURRENT_RUN_LIMIT" },
      });

      // A different JWT bearer is a different caller — it must not share
      // the saturated bucket (regression: all JWT callers keyed "anonymous").
      expect((await post("other-tok")).status).toBe(202);

      // Finishing runs releases slots for the gated caller.
      for (const release of releaseGates.splice(0)) release();
      await vi.waitFor(() =>
        expect(disconnectAllServers).toHaveBeenCalledTimes(3)
      );
      expect((await post("tok")).status).toBe(202);

      // Drain so later tests start with empty buckets.
      for (const release of releaseGates.splice(0)) release();
      await vi.waitFor(() =>
        expect(disconnectAllServers).toHaveBeenCalledTimes(4)
      );
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
