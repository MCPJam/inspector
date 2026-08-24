import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Covers the v1 WRITE surface: tools/call + prompts/get schema validation,
// the async eval-run POST (mocked prepare/execute seam), the eval read
// proxies (mocked ConvexHttpClient), and the OAuth import-tokens proxy.

const {
  validateGuestTokenMock,
  prepareEvalRunMock,
  authorEvalSuiteMock,
  createAuthorizedManagerMock,
  convexQueryMock,
  convexActionMock,
  convexMutationMock,
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
    authorEvalSuiteMock: vi.fn(),
    createAuthorizedManagerMock: vi.fn(),
    convexQueryMock: vi.fn(),
    convexActionMock: vi.fn(),
    convexMutationMock: vi.fn(),
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
  return {
    ...actual,
    prepareEvalRun: prepareEvalRunMock,
    authorEvalSuite: authorEvalSuiteMock,
  };
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
    mutation: convexMutationMock,
  })),
}));

import v1Routes from "../index.js";
import { MAX_RUN_GROUP_TARGETS, parseMaxConcurrentRuns } from "../evals.js";

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

// The suite the eval-run route reads to decide environment selection. No
// `environmentIds` = a legacy suite, which is what most of these tests are.
const SUITE_DOC = {
  _id: "suite_1",
  projectId: "p1",
  name: "Smoke",
};

/**
 * Stub Convex queries by FUNCTION NAME rather than by call order. The eval-run
 * route issues several reads per request (the suite, then the saved server
 * selection or the environment resolution), so `mockResolvedValueOnce` chains
 * would encode call order that has nothing to do with what a test is asserting.
 * Unlisted functions fall back to the legacy suite / `null`.
 */
function mockConvexQueries(
  handlers: Record<string, (args: any) => unknown> = {}
): void {
  convexQueryMock.mockImplementation(async (fn: string, args: any) => {
    if (Object.prototype.hasOwnProperty.call(handlers, fn)) {
      return handlers[fn]!(args);
    }
    if (fn === "testSuites:getTestSuite") return SUITE_DOC;
    return null;
  });
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
    MCPJAM_HARNESS_BROKER_DELIVERY: process.env.MCPJAM_HARNESS_BROKER_DELIVERY,
  };
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    mockConvexQueries();
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
    it("rejects an unknown key rather than silently dropping it (400)", async () => {
      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-runs",
        { suiteId: "suite_1", hostIds: ["h1"] }
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string; message?: string };
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.message).toContain("hostIds");
      expect(prepareEvalRunMock).not.toHaveBeenCalled();
    });

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

    it("requires serverIds when creating a new suite from inline tests", async () => {
      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-runs",
        {
          suiteName: "fresh suite",
          tests: [
            {
              title: "echo works",
              steps: [
                { id: "s1", kind: "prompt", prompt: "Use the echo tool" },
              ],
              runs: 1,
              model: "anthropic/claude-haiku-4.5",
              provider: "anthropic",
            },
          ],
        }
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string; message?: string };
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.message).toContain("serverIds are required");
      expect(prepareEvalRunMock).not.toHaveBeenCalled();
    });

    describe("rerun without serverIds", () => {
      function mockHappyCreate() {
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
        return { disconnectAllServers };
      }

      it("derives the suite's saved server selection and connects it", async () => {
        const { disconnectAllServers } = mockHappyCreate();
        mockConvexQueries({
          "testSuites:getSuiteRunServerSelection": () => ({
            serverIds: ["s_alpha", "s_beta"],
            serverNames: ["alpha", "beta"],
            source: "host_config",
          }),
        });

        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          { suiteId: "suite_1" }
        );

        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({
          runId: "run_1",
          suiteId: "suite_1",
          status: "running",
          caseUpsert: { committed: [], failed: [] },
          servers: [
            { id: "s_alpha", name: "alpha" },
            { id: "s_beta", name: "beta" },
          ],
          environment: null,
        });
        expect(convexQueryMock).toHaveBeenCalledWith(
          "testSuites:getSuiteRunServerSelection",
          { suiteId: "suite_1" }
        );
        // The manager connects the derived set, names included.
        expect(createAuthorizedManagerMock.mock.calls[0][3]).toEqual([
          "s_alpha",
          "s_beta",
        ]);
        expect(createAuthorizedManagerMock.mock.calls[0][7]).toEqual({
          serverNames: ["alpha", "beta"],
          // Threaded so per-server XAA servers mint instead of 500ing —
          // the v1 eval API has no host-persona input, so no xaaPolicy.
          xaaIssuer: expect.stringContaining("/xaa"),
        });
        expect(prepareEvalRunMock.mock.calls[0][1]).toMatchObject({
          serverIds: ["s_alpha", "s_beta"],
          serverNames: ["alpha", "beta"],
          suiteRerun: true,
        });
        await vi.waitFor(() =>
          expect(disconnectAllServers).toHaveBeenCalledTimes(1)
        );
      });

      it("fails actionably when the suite has no saved selection", async () => {
        mockHappyCreate();
        mockConvexQueries({
          "testSuites:getSuiteRunServerSelection": () => ({
            serverIds: [],
            serverNames: [],
            source: "none",
          }),
        });

        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          { suiteId: "suite_1" }
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as {
          code?: string;
          message?: string;
          details?: { reason?: string };
        };
        expect(body.code).toBe("VALIDATION_ERROR");
        expect(body.details?.reason).toBe("NO_SAVED_SERVER_SELECTION");
        expect(createAuthorizedManagerMock).not.toHaveBeenCalled();
        expect(prepareEvalRunMock).not.toHaveBeenCalled();
      });

      it("maps a suite the caller cannot see to 404", async () => {
        mockHappyCreate();
        mockConvexQueries({
          "testSuites:getTestSuite": () => {
            throw new Error("Suite not found or unauthorized");
          },
        });

        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          { suiteId: "suite_other" }
        );

        expect(res.status).toBe(404);
        expect(((await res.json()) as { code?: string }).code).toBe(
          "NOT_FOUND"
        );
      });

      it("maps a null selection read to 404, not a validation error", async () => {
        mockHappyCreate();
        mockConvexQueries({ "testSuites:getTestSuite": () => null });

        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          { suiteId: "suite_1" }
        );

        expect(res.status).toBe(404);
        expect(((await res.json()) as { code?: string }).code).toBe(
          "NOT_FOUND"
        );
      });

      it("degrades to an explicit-serverIds instruction on older backends", async () => {
        mockHappyCreate();
        mockConvexQueries({
          "testSuites:getSuiteRunServerSelection": () => {
            throw new Error(
              "Could not find public function for 'testSuites:getSuiteRunServerSelection'"
            );
          },
        });

        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          { suiteId: "suite_1" }
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as { code?: string; message?: string };
        expect(body.code).toBe("VALIDATION_ERROR");
        expect(body.message).toContain("Pass serverIds explicitly");
      });
    });

    describe("idempotent replay", () => {
      function mockReplay(status: string) {
        const disconnectAllServers = vi.fn().mockResolvedValue(undefined);
        createAuthorizedManagerMock.mockResolvedValue({
          manager: { disconnectAllServers },
          oauthServerUrls: {},
          authenticatedUserId: null,
        });
        const execute = vi.fn().mockResolvedValue(undefined);
        prepareEvalRunMock.mockResolvedValue({
          suiteId: "suite_1",
          runId: "run_1",
          caseUpsert: { committed: [], failed: [] },
          recorder: { finalize: vi.fn() },
          execute,
          // What the platform reports when a key (or the keyless fingerprint
          // window) matched an existing run.
          deduped: true,
          status,
        });
        mockConvexQueries({
          "testSuites:getSuiteRunServerSelection": () => ({
            serverIds: ["s_alpha"],
            serverNames: ["alpha"],
            source: "host_config",
          }),
        });
        return { execute, disconnectAllServers };
      }

      it("does NOT re-execute a replay of a FINISHED run", async () => {
        // The whole point of sending a key. Executing here would run every
        // case a second time and bill for it, over results already final.
        const { execute, disconnectAllServers } = mockReplay("completed");

        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          { suiteId: "suite_1", idempotencyKey: "same-key" }
        );

        expect(res.status).toBe(202);
        const body = (await res.json()) as any;
        expect(body.runId).toBe("run_1");
        // Reports what the run IS, not what a launch would have made it.
        expect(body.status).toBe("completed");
        expect(body.deduped).toBe(true);
        expect(execute).not.toHaveBeenCalled();
        // The manager and the concurrency slot are still settled — the
        // `.finally` that normally does it belongs to an execution that never
        // happened.
        await vi.waitFor(() =>
          expect(disconnectAllServers).toHaveBeenCalledTimes(1)
        );
      });

      it("releases the concurrency slot when it skips execution", async () => {
        // A skipped run that kept its slot would brick the org's quota just as
        // surely as a leaked one.
        mockReplay("completed");
        for (let i = 0; i < 5; i += 1) {
          const res = await request(
            makeApp(),
            "POST",
            "/api/v1/projects/p1/eval-runs",
            { suiteId: "suite_1", idempotencyKey: `key_${i}` }
          );
          expect(res.status).toBe(202);
        }
      });

      it("DOES execute a replay of a run still in flight", async () => {
        // Deliberately unchanged: an in-flight run and one abandoned mid-flight
        // are indistinguishable from here, and refusing to execute would strand
        // the second. Deciding that needs a liveness signal, not a guess.
        const { execute } = mockReplay("running");

        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          { suiteId: "suite_1", idempotencyKey: "same-key" }
        );

        expect(res.status).toBe(202);
        expect((await res.json()).status).toBe("running");
        expect(execute).toHaveBeenCalledTimes(1);
      });

      it("executes normally against a backend with no replay signal", async () => {
        // Deploy skew: absent `deduped` is UNKNOWN, not "fresh". Unknown must
        // keep the old behaviour rather than start refusing to run.
        const disconnectAllServers = vi.fn().mockResolvedValue(undefined);
        createAuthorizedManagerMock.mockResolvedValue({
          manager: { disconnectAllServers },
          oauthServerUrls: {},
          authenticatedUserId: null,
        });
        const execute = vi.fn().mockResolvedValue(undefined);
        prepareEvalRunMock.mockResolvedValue({
          suiteId: "suite_1",
          runId: "run_1",
          caseUpsert: { committed: [], failed: [] },
          recorder: { finalize: vi.fn() },
          execute,
        });
        mockConvexQueries({
          "testSuites:getSuiteRunServerSelection": () => ({
            serverIds: ["s_alpha"],
            serverNames: ["alpha"],
            source: "host_config",
          }),
        });

        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          { suiteId: "suite_1", idempotencyKey: "same-key" }
        );

        expect(res.status).toBe(202);
        const body = (await res.json()) as any;
        expect(body.status).toBe("running");
        expect(body.deduped).toBeUndefined();
        expect(execute).toHaveBeenCalledTimes(1);
      });
    });


    describe("environment-backed runs", () => {
      // Attach-ordered environments on the suite; the route's selection rule
      // reads this, not the caller's word.
      const ENV_SUITE_DOC = { ...SUITE_DOC, environmentIds: ["env_1"] };
      const PROJECT_ENVIRONMENTS = [
        { environmentId: "env_1", name: "Staging" },
        { environmentId: "env_2", name: "Prod" },
      ];

      /**
       * Make the suite environment-based and let `resolveEnvironmentForLaunch`
       * succeed. `projectEnvironments:listEnvironments` is stubbed too — it is
       * what the 400s read to name the attached candidates.
       */
      function mockEnvSuite(environmentIds: string[] = ["env_1"]): void {
        mockConvexQueries({
          "testSuites:getTestSuite": () => ({
            ...SUITE_DOC,
            environmentIds,
          }),
          "projectEnvironments:listEnvironments": () => PROJECT_ENVIRONMENTS,
          "projectEnvironments:resolveEnvironmentForLaunch": () =>
            RESOLVED_ENVIRONMENT,
        });
      }

      const RESOLVED_ENVIRONMENT = {
        environmentRef: {
          environmentId: "env_1",
          name: "Staging",
          revision: 7,
        },
        hostId: "host_1",
        hostConfigId: "hc_1",
        selectedServerIds: ["s_env"],
        // Live-healed projection, plus a server contributed by a pinned
        // plugin version — the manager must connect BOTH.
        servers: [
          { serverId: "s_env_live", name: "env server" },
          { serverId: "s_plugin", name: "plugin server" },
        ],
      };

      function mockHappyCreate() {
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
        return { disconnectAllServers };
      }

      const inlineTest = {
        title: "echo works",
        steps: [{ id: "s1", kind: "prompt", prompt: "Use the echo tool" }],
        runs: 1,
        model: "anthropic/claude-haiku-4.5",
        provider: "anthropic",
      };

      it("connects the environment's closed set and pins the run to its revision", async () => {
        mockHappyCreate();
        mockEnvSuite();

        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          { suiteId: "suite_1", environmentId: "env_1" }
        );

        expect(res.status).toBe(202);
        // The 202 names the environment the run is pinned to.
        expect(
          ((await res.json()) as { environment?: unknown }).environment
        ).toEqual({ id: "env_1", name: "Staging", revision: 7 });
        expect(convexQueryMock).toHaveBeenCalledWith(
          "projectEnvironments:resolveEnvironmentForLaunch",
          { projectId: "p1", environmentId: "env_1" }
        );
        // The suite's saved selection is never consulted for an env run.
        expect(convexQueryMock).not.toHaveBeenCalledWith(
          "testSuites:getSuiteRunServerSelection",
          expect.anything()
        );
        expect(createAuthorizedManagerMock.mock.calls[0][3]).toEqual([
          "s_env_live",
          "s_plugin",
        ]);
        expect(createAuthorizedManagerMock.mock.calls[0][7]).toMatchObject({
          serverNames: ["env server", "plugin server"],
        });
        // The resolution is handed down instead of re-resolved, so the run is
        // pinned to the revision whose servers were just connected.
        expect(prepareEvalRunMock.mock.calls[0][1]).toMatchObject({
          serverIds: ["s_env_live", "s_plugin"],
          resolvedEnvironment: RESOLVED_ENVIRONMENT,
        });
      });

      it("rejects serverIds alongside an environment instead of ignoring them", async () => {
        mockHappyCreate();
        mockEnvSuite();

        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          { suiteId: "suite_1", environmentId: "env_1", serverIds: ["s_bogus"] }
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as { code?: string; message?: string };
        expect(body.code).toBe("VALIDATION_ERROR");
        expect(body.message).toContain("mutually exclusive");
        expect(prepareEvalRunMock).not.toHaveBeenCalled();
      });

      it("requires a suiteId with an environment, before any authoring", async () => {
        mockHappyCreate();
        mockEnvSuite();

        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          {
            suiteName: "fresh suite",
            environmentId: "env_1",
            tests: [inlineTest],
          }
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as { code?: string; message?: string };
        expect(body.code).toBe("VALIDATION_ERROR");
        expect(body.message).toContain("suiteId is required");
        // Nothing was authored for a request that could never have been served.
        expect(prepareEvalRunMock).not.toHaveBeenCalled();
        expect(createAuthorizedManagerMock).not.toHaveBeenCalled();
      });

      it("rejects an environment the suite has not attached, naming the ones it has", async () => {
        mockHappyCreate();
        mockEnvSuite();

        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          { suiteId: "suite_1", environmentId: "env_other" }
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as {
          code?: string;
          message?: string;
          details?: { reason?: string };
        };
        expect(body.code).toBe("VALIDATION_ERROR");
        expect(body.details?.reason).toBe("ENVIRONMENT_NOT_ATTACHED");
        expect(body.message).toContain("Staging");
        // The rejection lands before authoring and before any connection.
        expect(prepareEvalRunMock).not.toHaveBeenCalled();
        expect(createAuthorizedManagerMock).not.toHaveBeenCalled();
      });

      it("launches an unattached project env when ephemeralEnvironment is true", async () => {
        mockHappyCreate();
        mockConvexQueries({
          "testSuites:getTestSuite": () => ({
            ...SUITE_DOC,
            environmentIds: [],
          }),
          "projectEnvironments:getEnvironment": () => ({
            environmentId: "env_other",
            projectId: "p1",
            name: "Adhoc",
          }),
          "projectEnvironments:resolveEnvironmentForLaunch": () =>
            RESOLVED_ENVIRONMENT,
        });

        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          {
            suiteId: "suite_1",
            environmentId: "env_other",
            ephemeralEnvironment: true,
          }
        );

        expect(res.status).toBe(202);
        expect(prepareEvalRunMock.mock.calls[0][1]).toMatchObject({
          environmentId: "env_other",
          ephemeralEnvironment: true,
        });
      });

      it("auto-selects the sole attached environment when none is named", async () => {
        mockHappyCreate();
        mockEnvSuite();

        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          { suiteId: "suite_1" }
        );

        expect(res.status).toBe(202);
        expect(
          ((await res.json()) as { environment?: unknown }).environment
        ).toEqual({ id: "env_1", name: "Staging", revision: 7 });
        // Never falls back to the legacy saved selection — that is exactly the
        // drift this rule closes (connect one set, snapshot another).
        expect(convexQueryMock).not.toHaveBeenCalledWith(
          "testSuites:getSuiteRunServerSelection",
          expect.anything()
        );
        expect(prepareEvalRunMock.mock.calls[0][1]).toMatchObject({
          environmentId: "env_1",
          serverIds: ["s_env_live", "s_plugin"],
        });
      });

      it("requires a choice when several environments are attached", async () => {
        mockHappyCreate();
        mockEnvSuite(["env_1", "env_2"]);

        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          { suiteId: "suite_1" }
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as {
          message?: string;
          details?: { reason?: string };
        };
        expect(body.details?.reason).toBe("ENVIRONMENT_REQUIRED");
        // Both candidates are named, so the caller can pick without a round trip.
        expect(body.message).toContain("Staging");
        expect(body.message).toContain("Prod");
        expect(prepareEvalRunMock).not.toHaveBeenCalled();
      });

      it("rejects a server override on an environment-based suite", async () => {
        mockHappyCreate();
        mockEnvSuite();

        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          { suiteId: "suite_1", serverIds: ["s_bogus"] }
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as {
          message?: string;
          details?: { reason?: string };
        };
        expect(body.details?.reason).toBe(
          "ENVIRONMENT_SERVERS_NOT_OVERRIDABLE"
        );
        expect(prepareEvalRunMock).not.toHaveBeenCalled();
      });

      it("maps a launch-resolution failure to 409 with the ENV_ reason", async () => {
        mockHappyCreate();
        const conflict = Object.assign(new Error("ConvexError"), {
          data: {
            code: "ENV_PLUGIN_DISABLED",
            message: "Pinned plugin is disabled.",
          },
        });
        mockConvexQueries({
          "testSuites:getTestSuite": () => ENV_SUITE_DOC,
          "projectEnvironments:resolveEnvironmentForLaunch": () => {
            throw conflict;
          },
        });

        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          { suiteId: "suite_1", environmentId: "env_1" }
        );

        expect(res.status).toBe(409);
        const body = (await res.json()) as {
          code?: string;
          message?: string;
          details?: { code?: string };
        };
        expect(body.code).toBe("CONFLICT");
        expect(body.message).toBe("Pinned plugin is disabled.");
        expect(body.details?.code).toBe("ENV_PLUGIN_DISABLED");
        expect(createAuthorizedManagerMock).not.toHaveBeenCalled();
        expect(prepareEvalRunMock).not.toHaveBeenCalled();
      });

      it("maps an unreadable environment to 404, not a conflict", async () => {
        mockHappyCreate();
        mockConvexQueries({
          "testSuites:getTestSuite": () => ENV_SUITE_DOC,
          "projectEnvironments:resolveEnvironmentForLaunch": () => {
            throw Object.assign(new Error("ConvexError"), {
              data: { code: "ENV_NOT_FOUND", message: "nope" },
            });
          },
        });

        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          { suiteId: "suite_1", environmentId: "env_1" }
        );

        expect(res.status).toBe(404);
        expect(((await res.json()) as { code?: string }).code).toBe(
          "NOT_FOUND"
        );
        expect(prepareEvalRunMock).not.toHaveBeenCalled();
      });
    });

    describe("inline test model validation", () => {
      const inlineTest = (model: string, provider = "anthropic") => ({
        title: "echo works",
        steps: [
          { id: "s1", kind: "prompt", prompt: "Use the echo tool to say hi" },
        ],
        runs: 1,
        model,
        provider,
      });

      function mockHappyCreate() {
        createAuthorizedManagerMock.mockResolvedValue({
          manager: {
            disconnectAllServers: vi.fn().mockResolvedValue(undefined),
          },
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
        //
        // Use a RETIRED id here. The gate admits anything in MODEL_LOOKUP
        // (BYOK statics ∪ hosted snapshot), so any id we might later add to
        // SUPPORTED_MODELS stops exercising this path — which is how the
        // previous fixture, claude-sonnet-4-6, quietly stopped testing the
        // rejection once that model shipped in the picker (MMA-2).
        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-runs",
          {
            suiteName: "smoke",
            serverIds: ["s1"],
            tests: [inlineTest("claude-3-7-sonnet-latest")],
          }
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
            tests: [inlineTest("claude-3-7-sonnet-latest")],
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
        servers: [{ id: "s1" }],
        environment: null,
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
      mockConvexQueries({
        "testSuites:getTestSuiteRun": () => ({
          ...RUN_DOC,
          status: "running",
        }),
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
      mockConvexQueries({
        "testSuites:getTestSuiteRun": () => ({ ...RUN_DOC, status: "failed" }),
      });

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
              steps: [{ id: "s1", kind: "prompt", prompt: "do it" }],
              runs: 1,
              model: "anthropic/claude-haiku-4.5",
              provider: "anthropic",
            },
          ],
        }
      );
      expect(res.status).toBe(202);
      expect(prepareEvalRunMock.mock.calls[0][1]).toMatchObject({
        suiteRerun: false,
        tests: [
          expect.objectContaining({
            steps: [{ id: "s1", kind: "prompt", prompt: "do it" }],
            query: "do it",
          }),
        ],
      });
      await vi.waitFor(() =>
        expect(disconnectAllServers).toHaveBeenCalledTimes(1)
      );
    });
  });

  describe("POST /eval-suites (author-only)", () => {
    const VALID_CASE = {
      title: "echo works",
      steps: [
        { id: "s1", kind: "prompt", prompt: "Use the echo tool" },
        {
          id: "s2",
          kind: "assert",
          assertion: {
            type: "toolCalledWith",
            toolName: "echo",
            args: { args: {} },
          },
        },
      ],
    };

    it("rejects a body with no cases (400) before any side effect", async () => {
      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-suites",
        {
          name: "Fresh suite",
          serverIds: ["s1"],
          model: "anthropic/claude-haiku-4.5",
          tests: [],
        }
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "VALIDATION_ERROR"
      );
      expect(authorEvalSuiteMock).not.toHaveBeenCalled();
      expect(createAuthorizedManagerMock).not.toHaveBeenCalled();
    });

    it("rejects an unknown model before connecting any server", async () => {
      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-suites",
        {
          name: "Fresh suite",
          serverIds: ["s1"],
          model: "anthropic/not-a-real-model",
          tests: [VALID_CASE],
        }
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string; message?: string };
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.message).toContain("Unknown model");
      expect(createAuthorizedManagerMock).not.toHaveBeenCalled();
      expect(authorEvalSuiteMock).not.toHaveBeenCalled();
    });

    it("rejects a case with no steps (400)", async () => {
      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-suites",
        {
          name: "Fresh suite",
          serverIds: ["s1"],
          model: "anthropic/claude-haiku-4.5",
          tests: [{ title: "no steps" }],
        }
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "VALIDATION_ERROR"
      );
      expect(createAuthorizedManagerMock).not.toHaveBeenCalled();
    });

    it("rejects an unknown key rather than silently dropping it (400)", async () => {
      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-suites",
        {
          name: "Fresh suite",
          serverIds: ["s1"],
          model: "anthropic/claude-haiku-4.5",
          tests: [VALID_CASE],
          hostIds: ["h1"],
        }
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string; message?: string };
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.message).toContain("hostIds");
      expect(authorEvalSuiteMock).not.toHaveBeenCalled();
      expect(createAuthorizedManagerMock).not.toHaveBeenCalled();
    });

    it("rejects a case with an empty steps array (400)", async () => {
      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-suites",
        {
          name: "Fresh suite",
          serverIds: ["s1"],
          model: "anthropic/claude-haiku-4.5",
          tests: [{ title: "empty steps", steps: [] }],
        }
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "VALIDATION_ERROR"
      );
      expect(createAuthorizedManagerMock).not.toHaveBeenCalled();
      expect(authorEvalSuiteMock).not.toHaveBeenCalled();
    });

    it("authors the suite and disconnects the manager (no run started)", async () => {
      const disconnectAllServers = vi.fn().mockResolvedValue(undefined);
      createAuthorizedManagerMock.mockResolvedValue({
        manager: {
          listServers: () => ["s1"],
          disconnectAllServers,
        },
      });
      authorEvalSuiteMock.mockResolvedValue({
        suiteId: "suite_new",
        suiteName: "Fresh suite",
        caseUpsert: { committed: [{ name: "echo works" }], failed: [] },
      });

      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-suites",
        {
          name: "Fresh suite",
          serverIds: ["s1"],
          serverNames: ["Echo"],
          model: "anthropic/claude-haiku-4.5",
          tests: [VALID_CASE],
        }
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        suiteId?: string;
        name?: string;
        servers?: unknown;
      };
      expect(body.suiteId).toBe("suite_new");
      expect(body.name).toBe("Fresh suite");

      // The run engine is never invoked — this is author-only.
      expect(prepareEvalRunMock).not.toHaveBeenCalled();
      expect(authorEvalSuiteMock).toHaveBeenCalledTimes(1);
      const authoredArgs = authorEvalSuiteMock.mock.calls[0][0];
      expect(authoredArgs.suiteId).toBeNull();
      expect(authoredArgs.suiteName).toBe("Fresh suite");
      expect(authoredArgs.resolvedServerIds).toEqual(["s1"]);
      // The case's `steps` stay on the authored payload and are projected onto
      // denormalized display fields: prompt -> query, assert -> expected call.
      expect(authoredArgs.tests[0].steps).toEqual(VALID_CASE.steps);
      expect(authoredArgs.tests[0].query).toBe("Use the echo tool");
      expect(authoredArgs.tests[0].expectedToolCalls).toEqual([
        { toolName: "echo", arguments: {} },
      ]);
      expect(authoredArgs.tests[0].runs).toBe(1);
      expect(authoredArgs.tests[0].provider).toBe("anthropic");
      expect(disconnectAllServers).toHaveBeenCalledTimes(1);
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


  describe("POST /eval-run-groups", () => {
    // A suite with two attached hosts — the shape a fan-out is for. The route
    // reads `hostAttachments` for names and attachment membership.
    const HOST_SUITE = {
      ...SUITE_DOC,
      hostAttachments: [
        { namedHostId: "host_claude", hostName: "Claude" },
        { namedHostId: "host_chatgpt", hostName: "ChatGPT" },
      ],
    };

    /**
     * A prepare seam whose `execute` never settles until released, so a test
     * can observe the group HOLDING its slot. Returns the release handles and
     * the manager teardown spy.
     */
    function mockPendingLaunches(perCall?: () => Record<string, unknown>) {
      const disconnectAllServers = vi.fn().mockResolvedValue(undefined);
      createAuthorizedManagerMock.mockResolvedValue({
        manager: { disconnectAllServers },
        oauthServerUrls: {},
        authenticatedUserId: null,
      });
      const releaseGates: Array<() => void> = [];
      let call = 0;
      prepareEvalRunMock.mockImplementation(async () => {
        call += 1;
        return {
          suiteId: "suite_1",
          runId: `run_${call}`,
          caseUpsert: { committed: [], failed: [] },
          recorder: { finalize: vi.fn() },
          execute: vi.fn(
            () => new Promise<void>((resolve) => releaseGates.push(resolve))
          ),
          ...(perCall ? perCall() : {}),
        };
      });
      return { releaseGates, disconnectAllServers };
    }

    function hostSuiteQueries(
      extra: Record<string, (args: any) => unknown> = {}
    ) {
      mockConvexQueries({
        "testSuites:getTestSuite": () => HOST_SUITE,
        "testSuites:getSuiteRunServerSelection": () => ({
          serverIds: ["s_alpha"],
          serverNames: ["alpha"],
          source: "host_config",
        }),
        // The group's dry pass resolves each target's host config to run the
        // static admission checks. A plain (non-harness) host by default;
        // the harness test overrides this.
        "hosts:getHost": () => ({ config: { hostStyle: "mcpjam" } }),
        ...extra,
      });
    }

    async function drain(
      releaseGates: Array<() => void>,
      disconnectAllServers: ReturnType<typeof vi.fn>,
      expected: number
    ) {
      for (const release of releaseGates.splice(0)) release();
      await vi.waitFor(() =>
        expect(disconnectAllServers).toHaveBeenCalledTimes(expected)
      );
    }

    it("launches unattached environments when ephemeralEnvironment is true", async () => {
      mockConvexQueries({
        "testSuites:getTestSuite": () => ({
          ...SUITE_DOC,
          environmentIds: [],
        }),
        "projectEnvironments:getEnvironment": () => ({
          environmentId: "env_adhoc",
          projectId: "p1",
          name: "Adhoc",
        }),
        "projectEnvironments:resolveEnvironmentForLaunch": () => ({
          environmentRef: {
            environmentId: "env_adhoc",
            name: "Adhoc",
            revision: 1,
          },
          hostId: "host_claude",
          hostConfigId: "hc_1",
          selectedServerIds: ["s_env"],
          effectiveServerIds: ["s_env"],
          servers: [{ serverId: "s_env", name: "env" }],
        }),
        "hosts:getHost": () => ({ config: { hostStyle: "mcpjam" } }),
      });
      const { releaseGates, disconnectAllServers } = mockPendingLaunches();

      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-run-groups",
        {
          suiteId: "suite_1",
          ephemeralEnvironment: true,
          targets: [{ environmentId: "env_adhoc" }],
        }
      );

      expect(res.status).toBe(202);
      expect(prepareEvalRunMock.mock.calls[0][1]).toMatchObject({
        environmentId: "env_adhoc",
        ephemeralEnvironment: true,
      });
      await drain(releaseGates, disconnectAllServers, 1);
    });

    it("launches one run per target under a single minted group id", async () => {
      hostSuiteQueries();
      const { releaseGates, disconnectAllServers } = mockPendingLaunches();

      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-run-groups",
        {
          suiteId: "suite_1",
          targets: [
            { namedHostId: "host_claude" },
            { namedHostId: "host_chatgpt" },
          ],
        }
      );

      expect(res.status).toBe(202);
      const body = (await res.json()) as any;
      expect(body.outcome).toBe("started");
      expect(body.startedCount).toBe(2);
      expect(body.failedCount).toBe(0);
      expect(typeof body.runGroupId).toBe("string");
      expect(body.targets.map((entry: any) => entry.target.name)).toEqual([
        "Claude",
        "ChatGPT",
      ]);
      expect(body.targets.every((entry: any) => entry.status === "started")).toBe(
        true
      );
      // The entry discriminant owns `status`; the RUN's own status is
      // `runStatus`, so a reader can never branch on the wrong one.
      expect(body.targets[0].runStatus).toBe("running");
      // Deprecated mirrors of the first started run, for readers written
      // against the single-run receipt.
      expect(body.runId).toBe("run_1");
      expect(body.status).toBe("running");

      // Every sibling carries the SAME group id, and each target's own host.
      const groupIds = prepareEvalRunMock.mock.calls.map(
        (call) => call[1].runGroupId
      );
      expect(new Set(groupIds).size).toBe(1);
      expect(groupIds[0]).toBe(body.runGroupId);
      expect(
        prepareEvalRunMock.mock.calls.map((call) => call[1].namedHostId)
      ).toEqual(["host_claude", "host_chatgpt"]);

      await drain(releaseGates, disconnectAllServers, 2);
    });

    it("holds ONE slot for the whole group, and releases it only after the LAST sibling", async () => {
      hostSuiteQueries();
      const { releaseGates, disconnectAllServers } = mockPendingLaunches();
      const app = makeApp();

      const group = await request(
        app,
        "POST",
        "/api/v1/projects/p1/eval-run-groups",
        {
          suiteId: "suite_1",
          targets: [
            { namedHostId: "host_claude" },
            { namedHostId: "host_chatgpt" },
          ],
        }
      );
      expect(group.status).toBe(202);

      // Two targets under ONE slot: with the cap at 2, a single further launch
      // still fits. Charging per target would have exhausted the cap here,
      // which is what makes a 3-target fan-out unlaunchable.
      const single = await request(app, "POST", "/api/v1/projects/p1/eval-runs", {
        suiteId: "suite_1",
        serverIds: ["s1"],
      });
      expect(single.status).toBe(202);

      // …and the next one is gated, so the group's slot is genuinely held.
      const gated = await request(app, "POST", "/api/v1/projects/p1/eval-runs", {
        suiteId: "suite_1",
        serverIds: ["s1"],
      });
      expect(gated.status).toBe(429);

      // Release exactly ONE sibling: the group still owns its slot.
      releaseGates.splice(0, 1)[0]!();
      await vi.waitFor(() =>
        expect(disconnectAllServers).toHaveBeenCalledTimes(1)
      );
      expect(
        (
          await request(app, "POST", "/api/v1/projects/p1/eval-runs", {
            suiteId: "suite_1",
            serverIds: ["s1"],
          })
        ).status
      ).toBe(429);

      await drain(releaseGates, disconnectAllServers, 3);
      expect(
        (
          await request(app, "POST", "/api/v1/projects/p1/eval-runs", {
            suiteId: "suite_1",
            serverIds: ["s1"],
          })
        ).status
      ).toBe(202);
      await drain(releaseGates, disconnectAllServers, 4);
    });

    it("RATE_LIMITs a group when the caller is already at the cap", async () => {
      hostSuiteQueries();
      const { releaseGates, disconnectAllServers } = mockPendingLaunches();
      const app = makeApp();
      for (let i = 0; i < 2; i += 1) {
        expect(
          (
            await request(app, "POST", "/api/v1/projects/p1/eval-runs", {
              suiteId: "suite_1",
              serverIds: ["s1"],
            })
          ).status
        ).toBe(202);
      }
      const res = await request(
        app,
        "POST",
        "/api/v1/projects/p1/eval-run-groups",
        { suiteId: "suite_1", targets: [{ namedHostId: "host_claude" }] }
      );
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({
        code: "RATE_LIMITED",
        details: { reason: "CONCURRENT_RUN_LIMIT" },
      });
      await drain(releaseGates, disconnectAllServers, 2);
    });

    it("a PARTIAL group releases the slot fully — the failed target never reaches a .finally", async () => {
      hostSuiteQueries();
      const disconnectAllServers = vi.fn().mockResolvedValue(undefined);
      createAuthorizedManagerMock.mockResolvedValue({
        manager: { disconnectAllServers },
        oauthServerUrls: {},
        authenticatedUserId: null,
      });
      const releaseGates: Array<() => void> = [];
      let call = 0;
      prepareEvalRunMock.mockImplementation(async () => {
        call += 1;
        if (call === 2) throw new Error("environment revision conflict");
        return {
          suiteId: "suite_1",
          runId: "run_1",
          caseUpsert: { committed: [], failed: [] },
          recorder: { finalize: vi.fn() },
          execute: vi.fn(
            () => new Promise<void>((resolve) => releaseGates.push(resolve))
          ),
        };
      });

      const app = makeApp();
      const res = await request(
        app,
        "POST",
        "/api/v1/projects/p1/eval-run-groups",
        {
          suiteId: "suite_1",
          targets: [
            { namedHostId: "host_claude" },
            { namedHostId: "host_chatgpt" },
          ],
        }
      );
      expect(res.status).toBe(202);
      const body = (await res.json()) as any;
      expect(body.outcome).toBe("partial");
      expect(body.startedCount).toBe(1);
      expect(body.failedCount).toBe(1);
      expect(body.targets[1]).toMatchObject({
        status: "failed",
        error: { message: expect.stringContaining("revision conflict") },
      });
      // A runtime per-target failure does NOT abort its siblings.
      expect(body.runId).toBe("run_1");

      // The failed target decremented in the launch loop, so releasing the one
      // started sibling releases the whole group's slot.
      await drain(releaseGates, disconnectAllServers, 1);
      expect(
        (
          await request(app, "POST", "/api/v1/projects/p1/eval-runs", {
            suiteId: "suite_1",
            serverIds: ["s1"],
          })
        ).status
      ).toBe(202);
      await drain(releaseGates, disconnectAllServers, 2);
    });

    it("an ALL-FAILED group releases its slot — a leak here bricks the org's quota", async () => {
      hostSuiteQueries();
      const disconnectAllServers = vi.fn().mockResolvedValue(undefined);
      createAuthorizedManagerMock.mockResolvedValue({
        manager: { disconnectAllServers },
        oauthServerUrls: {},
        authenticatedUserId: null,
      });
      prepareEvalRunMock.mockRejectedValue(new Error("backend unavailable"));

      const app = makeApp();
      const res = await request(
        app,
        "POST",
        "/api/v1/projects/p1/eval-run-groups",
        {
          suiteId: "suite_1",
          targets: [
            { namedHostId: "host_claude" },
            { namedHostId: "host_chatgpt" },
          ],
        }
      );
      expect(res.status).toBe(202);
      const body = (await res.json()) as any;
      expect(body.outcome).toBe("failed");
      expect(body.startedCount).toBe(0);
      expect(body.failedCount).toBe(2);
      // No first started run to mirror — the deprecated fields stay ABSENT
      // rather than inventing one.
      expect(body.runId).toBeUndefined();

      // The slot must be back. Two fresh single launches both fit.
      const { releaseGates, disconnectAllServers: d2 } = mockPendingLaunches();
      for (let i = 0; i < 2; i += 1) {
        expect(
          (
            await request(app, "POST", "/api/v1/projects/p1/eval-runs", {
              suiteId: "suite_1",
              serverIds: ["s1"],
            })
          ).status
        ).toBe(202);
      }
      await drain(releaseGates, d2, 2);
    });

    it("rejects an unattached target with ZERO runs started", async () => {
      hostSuiteQueries();
      mockPendingLaunches();
      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-run-groups",
        {
          suiteId: "suite_1",
          targets: [
            { namedHostId: "host_claude" },
            { namedHostId: "host_nope" },
          ],
        }
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: "VALIDATION_ERROR",
        details: { reason: "HOST_NOT_ATTACHED" },
      });
      // The whole point of validating first: nothing spent on a request that
      // was never satisfiable.
      expect(prepareEvalRunMock).not.toHaveBeenCalled();
    });

    it("rejects a HETEROGENEOUS target list", async () => {
      hostSuiteQueries();
      mockPendingLaunches();
      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-run-groups",
        {
          suiteId: "suite_1",
          targets: [
            { namedHostId: "host_claude" },
            { environmentId: "env_1" },
          ],
        }
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        details: { reason: "HETEROGENEOUS_TARGETS" },
      });
      expect(prepareEvalRunMock).not.toHaveBeenCalled();
    });

    it("rejects more targets than the fan-out bound allows", async () => {
      hostSuiteQueries();
      mockPendingLaunches();
      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-run-groups",
        {
          suiteId: "suite_1",
          targets: Array.from({ length: MAX_RUN_GROUP_TARGETS + 1 }, (_, i) => ({
            namedHostId: `host_${i}`,
          })),
        }
      );
      expect(res.status).toBe(400);
      expect(prepareEvalRunMock).not.toHaveBeenCalled();
    });

    it("refuses a target whose host selects an unavailable harness, before any sibling starts", async () => {
      // The static half of the harness admission gate, run during the group's
      // dry pass. Without it target 1 would already be spending when target 2
      // failed a check that needed no run row.
      //
      // The unavailability is stated by the FIXTURE, not inherited from the
      // machine: switching broker delivery off makes the shared runtime check
      // fail for a reason this test controls, so a CI box that happens to
      // carry harness credentials still exercises the refusal.
      process.env.MCPJAM_HARNESS_BROKER_DELIVERY = "false";
      hostSuiteQueries({
        "hosts:getHost": () => ({ config: { harness: "claude-code" } }),
      });
      mockPendingLaunches();
      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-run-groups",
        {
          suiteId: "suite_1",
          targets: [
            { namedHostId: "host_claude" },
            { namedHostId: "host_chatgpt" },
          ],
        }
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.details.reason).toBe("HARNESS_UNAVAILABLE");
      expect(body.message).toContain("Claude");
      expect(prepareEvalRunMock).not.toHaveBeenCalled();
    });

    it("judges an ENVIRONMENT target against its OWN host, not the suite default", async () => {
      // An environment pins a `hostId`, and that is the host whose config the
      // run row freezes. Judging the suite's default host instead would admit
      // an environment pinned to a harness this server cannot drive — the
      // exact mis-attribution the gate exists to stop.
      process.env.MCPJAM_HARNESS_BROKER_DELIVERY = "false";
      mockConvexQueries({
        "testSuites:getTestSuite": () => ({
          ...SUITE_DOC,
          environmentIds: ["env_1", "env_2"],
        }),
        "projectEnvironments:listEnvironments": () => [
          { environmentId: "env_1", name: "Staging" },
          { environmentId: "env_2", name: "Prod" },
        ],
        "projectEnvironments:resolveEnvironmentForLaunch": () => ({
          environmentRef: { environmentId: "env_1", name: "Staging", revision: 1 },
          hostId: "host_harness",
          selectedServerIds: ["s_env"],
        }),
        "testSuites:getSuiteRunServerSelection": () => ({
          serverIds: ["s_env"],
          serverNames: ["env server"],
          source: "environment",
        }),
        // The SUITE default is a plain host; only the environment's own host
        // carries the harness. A gate reading the wrong one answers 202.
        "hostConfigsV2:getSuiteConfig": () => ({ hostStyle: "mcpjam" }),
        "hosts:getHost": (args: any) =>
          args?.hostId === "host_harness"
            ? { config: { harness: "claude-code" } }
            : { config: { hostStyle: "mcpjam" } },
      });
      mockPendingLaunches();

      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-run-groups",
        {
          suiteId: "suite_1",
          targets: [{ environmentId: "env_1" }, { environmentId: "env_2" }],
        }
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        details: { reason: "HARNESS_UNAVAILABLE" },
      });
      expect(prepareEvalRunMock).not.toHaveBeenCalled();
    });

    it("REJECTS a knob this route does not carry instead of dropping it", async () => {
      // `serverIds` and `refreshSnapshot` are single-run-only, and they are
      // precisely what a caller adapting a working single-run body will try.
      // Stripping them would answer 202 while discarding the thing asked for.
      hostSuiteQueries();
      mockPendingLaunches();
      for (const knob of [{ serverIds: ["s_alpha"] }, { refreshSnapshot: true }]) {
        const res = await request(
          makeApp(),
          "POST",
          "/api/v1/projects/p1/eval-run-groups",
          {
            suiteId: "suite_1",
            targets: [{ namedHostId: "host_claude" }],
            ...knob,
          }
        );
        expect(res.status).toBe(400);
        expect((await res.json()) as any).toMatchObject({
          code: "VALIDATION_ERROR",
        });
      }
      expect(prepareEvalRunMock).not.toHaveBeenCalled();
    });

    it("deduplicates repeated targets instead of launching twice", async () => {
      hostSuiteQueries();
      const { releaseGates, disconnectAllServers } = mockPendingLaunches();
      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-run-groups",
        {
          suiteId: "suite_1",
          targets: [
            { namedHostId: "host_claude" },
            { namedHostId: "host_claude" },
          ],
        }
      );
      expect(res.status).toBe(202);
      expect(((await res.json()) as any).startedCount).toBe(1);
      expect(prepareEvalRunMock).toHaveBeenCalledTimes(1);
      await drain(releaseGates, disconnectAllServers, 1);
    });

    it("normalizes the PUBLIC match-option vocabulary and forwards the knobs", async () => {
      hostSuiteQueries();
      const { releaseGates, disconnectAllServers } = mockPendingLaunches();
      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-run-groups",
        {
          suiteId: "suite_1",
          targets: [{ namedHostId: "host_claude" }],
          iterationOverride: 3,
          caseIds: ["case_1"],
          matchOptionsOverride: {
            toolCallOrder: "in-order",
            extraToolCalls: "unlimited",
            arguments: "partial",
          },
          skillsOverride: "exclude",
          notes: "nightly",
          passCriteria: { minimumPassRate: 80 },
        }
      );
      expect(res.status).toBe(202);
      const forwarded = prepareEvalRunMock.mock.calls[0][1];
      expect(forwarded.iterationOverride).toBe(3);
      expect(forwarded.caseIds).toEqual(["case_1"]);
      expect(forwarded.skillsOverride).toBe("exclude");
      expect(forwarded.notes).toBe("nightly");
      expect(forwarded.passCriteria).toEqual({ minimumPassRate: 80 });
      expect(forwarded.matchOptionsOverride).toEqual({
        toolCallOrder: "superset",
        maxExtraToolCalls: null,
        argumentMatching: "partial",
      });
      await drain(releaseGates, disconnectAllServers, 1);
    });

    it("replays a keyed group onto the SAME group id and the same per-target run keys", async () => {
      hostSuiteQueries();
      const { releaseGates, disconnectAllServers } = mockPendingLaunches();
      const app = makeApp();
      const body = {
        suiteId: "suite_1",
        targets: [
          { namedHostId: "host_claude" },
          { namedHostId: "host_chatgpt" },
        ],
        idempotencyKey: "trigger-42",
      };

      const first = (await (
        await request(app, "POST", "/api/v1/projects/p1/eval-run-groups", body)
      ).json()) as any;
      const firstKeys = prepareEvalRunMock.mock.calls.map(
        (call) => call[1].idempotencyKey
      );
      // Each target gets its OWN derived key. One shared key would return
      // target 1's run for every target; no key at all would double-launch.
      expect(new Set(firstKeys).size).toBe(2);

      await drain(releaseGates, disconnectAllServers, 2);
      prepareEvalRunMock.mockClear();

      // Simulate a retry after a crash mid-launch: the SAME request replays.
      const { releaseGates: gates2, disconnectAllServers: d2 } =
        mockPendingLaunches();
      const replay = (await (
        await request(app, "POST", "/api/v1/projects/p1/eval-run-groups", body)
      ).json()) as any;
      expect(replay.runGroupId).toBe(first.runGroupId);
      expect(
        prepareEvalRunMock.mock.calls.map((call) => call[1].idempotencyKey)
      ).toEqual(firstKeys);
      await drain(gates2, d2, 2);
    });

    it("does not treat a client-supplied runGroupId on the single-run route as a group", async () => {
      mockConvexQueries({
        "testSuites:getSuiteRunServerSelection": () => ({
          serverIds: ["s_alpha"],
          serverNames: ["alpha"],
        }),
      });
      const { releaseGates, disconnectAllServers } = mockPendingLaunches();
      const app = makeApp();
      const post = () =>
        request(app, "POST", "/api/v1/projects/p1/eval-runs", {
          suiteId: "suite_1",
          runGroupId: "client-minted",
        });

      const first = await post();
      expect(first.status).toBe(202);
      // Echoed as a label…
      expect((await first.json()) as any).toMatchObject({
        runGroupId: "client-minted",
      });
      expect((await post()).status).toBe(202);
      // …and metered as N independent launches, not one group.
      expect((await post()).status).toBe(429);
      await drain(releaseGates, disconnectAllServers, 2);
    });
  });

  describe("POST /eval-suites/:suiteId/environments", () => {
    it("appends atomically and reports the resulting attachment list", async () => {
      // NOT a read-modify-write on the replace door: that would silently
      // detach an environment someone else attached in between, and the
      // compose-and-run path attaches on every launch.
      mockConvexQueries();
      convexMutationMock.mockResolvedValue({
        attached: true,
        environmentIds: ["env_a", "env_b"],
      });

      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-suites/suite_1/environments",
        { environmentId: "env_b" }
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        suiteId: "suite_1",
        attached: true,
        environmentIds: ["env_a", "env_b"],
      });
      expect(convexMutationMock).toHaveBeenCalledWith(
        "testSuites:attachEnvironment",
        { suiteId: "suite_1", environmentId: "env_b" }
      );
    });

    it("reports an already-attached environment as a no-op, not a failure", async () => {
      // What lets a retried compose-and-run converge.
      mockConvexQueries();
      convexMutationMock.mockResolvedValue({
        attached: false,
        environmentIds: ["env_a"],
      });
      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-suites/suite_1/environments",
        { environmentId: "env_a" }
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).attached).toBe(false);
    });

    it("404s a suite from another project before touching the backend", async () => {
      mockConvexQueries({
        "testSuites:getTestSuite": () => ({
          ...SUITE_DOC,
          projectId: "other",
        }),
      });
      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-suites/suite_1/environments",
        { environmentId: "env_b" }
      );
      expect(res.status).toBe(404);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("names the alternative when the backend has no atomic append yet", async () => {
      mockConvexQueries();
      convexMutationMock.mockRejectedValue(
        new Error("Could not find public function for 'testSuites'")
      );
      const res = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/eval-suites/suite_1/environments",
        { environmentId: "env_b" }
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.details.reason).toBe("ATTACH_UNAVAILABLE");
      expect(body.message).toContain("environmentIds");
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
        environment: null,
        runNumber: 3,
        status: "completed",
        result: "passed",
        summary: { total: 2, passed: 2, failed: 0, passRate: 1 },
        source: "api",
        notes: null,
        createdAt: 1,
        completedAt: 2,
        // Always present on the detail, so a caller can branch on
        // `judges.<name>.status` without first proving the field exists.
        // `null` here means this run was never sent to that judge.
        judges: {
          goalCompletion: {
            status: null,
            errorCode: null,
            summary: null,
            generatedAt: null,
            modelUsed: null,
            threshold: null,
            cases: [],
          },
          groundedness: {
            status: null,
            errorCode: null,
            summary: null,
            generatedAt: null,
            modelUsed: null,
            threshold: null,
            cases: [],
          },
        },
      });
    });

    it("surfaces a RECORDED execution engine, and only when the run has one", async () => {
      // The omission case is pinned by the exact-match assertion above: a run
      // whose snapshot predates the field must not acquire `executionEngine`,
      // because absent means UNKNOWN and reporting `emulated` would be a claim
      // about a run nobody attributed.
      convexQueryMock.mockResolvedValueOnce({
        ...RUN_DOC,
        configSnapshot: { executionEngine: "harness:claude-code" },
      });
      const res = await request(
        makeApp(),
        "GET",
        "/api/v1/projects/p1/eval-runs/run_1"
      );
      expect(res.status).toBe(200);
      expect((await res.json()) as any).toMatchObject({
        id: "run_1",
        executionEngine: "harness:claude-code",
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
      convexQueryMock.mockResolvedValueOnce(RUN_DOC).mockResolvedValueOnce({
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
