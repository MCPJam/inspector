/**
 * The public persisted-conformance surface: what a caller may say, and what
 * it may not.
 *
 * Convex is mocked at the `convex/browser` boundary. These prove the
 * GATEWAY's behaviour — not the backend's own scoring, which is C0.
 *
 * The cases worth writing:
 *
 *   1. A BODY CANNOT CHOOSE THE TARGET. The URL names a project and a saved
 *      server. A body that tried to supply a URL is a 400.
 *   2. OAuth is refused at the schema. This surface has no consent loop.
 *   3. A start detaches `executePersistedConformanceRun` with `source: "api"`
 *      and a saved-server target. The receipt arrives from `onRunStarted`.
 *   4. GET enforces tenancy: a run whose `projectId` is not the path's 404s.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const {
  validateGuestTokenMock,
  validateApiKeyMock,
  resolveUserByExternalIdMock,
  lookupWorkosKeyBindingMock,
  convexQueryMock,
  convexMutationMock,
  authorizeServerMock,
  executePersistedConformanceRunMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  validateApiKeyMock: vi.fn(),
  resolveUserByExternalIdMock: vi.fn(),
  lookupWorkosKeyBindingMock: vi.fn(),
  convexQueryMock: vi.fn(),
  convexMutationMock: vi.fn(),
  authorizeServerMock: vi.fn(),
  executePersistedConformanceRunMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));
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
vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
    mutation: convexMutationMock,
  })),
}));
vi.mock("../../../services/conformance-run-executor.js", () => ({
  executePersistedConformanceRun: executePersistedConformanceRunMock,
}));

vi.mock("../../web/auth.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../../web/auth.js",
  );
  return { ...actual, authorizeServer: authorizeServerMock };
});

import v1Routes from "../index.js";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function request(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string | null } = {},
): Promise<Response> {
  const { body, token = "tok" } = opts;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return Promise.resolve(
    makeApp().request(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

const HTTP_SERVER = {
  authorized: true,
  role: "owner",
  accessLevel: "project_member",
  permissions: { chatOnly: false },
  serverConfig: {
    transportType: "http" as const,
    url: "https://connector.example.com/mcp",
  },
};

const RUN_ROW = {
  _id: "run_1",
  projectId: "p1",
  serverId: "s1",
  source: "api",
  status: "completed",
  outcome: "passed",
  score: 100,
  pending: 1,
  requestedSuites: ["protocol"],
  createdAt: 1,
  completedAt: 2,
  reports: [
    {
      suiteKind: "protocol",
      status: "completed",
      outcome: "passed",
      score: 100,
      pending: 1,
      profileId: "mcp-protocol",
      profileVersion: "1",
      reportUrl: "https://storage.example.com/report.json",
    },
  ],
};

describe("v1 persisted conformance runs", () => {
  const originalEnv = {
    CONVEX_URL: process.env.CONVEX_URL,
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    authorizeServerMock.mockResolvedValue(HTTP_SERVER);
    executePersistedConformanceRunMock.mockImplementation(async (args: any) => {
      await args.onRunStarted?.("run_1", {
        reused: false,
        status: "queued",
      });
      return { runId: "run_1" };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
  });

  describe("auth", () => {
    it("rejects a request with no bearer token", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/servers/s1/conformance-runs",
        { token: null },
      );
      expect(res.status).toBe(401);
      expect(executePersistedConformanceRunMock).not.toHaveBeenCalled();
    });

    it("denies guest callers", async () => {
      validateGuestTokenMock.mockResolvedValue({
        valid: true,
        guestId: "guest_1",
      });
      const res = await request(
        "POST",
        "/api/v1/projects/p1/servers/s1/conformance-runs",
        { token: "guest-jwt" },
      );
      expect(res.status).toBe(401);
      expect(executePersistedConformanceRunMock).not.toHaveBeenCalled();
    });
  });

  describe("starting a run", () => {
    it("answers 202 and detaches against the SAVED server", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/servers/s1/conformance-runs",
        { body: {} },
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({
        runId: "run_1",
        projectId: "p1",
        serverId: "s1",
        status: "queued",
        deduped: false,
        requestedSuites: ["protocol", "apps", "tasks"],
      });
      expect(executePersistedConformanceRunMock).toHaveBeenCalledTimes(1);
      expect(executePersistedConformanceRunMock.mock.calls[0]![0]).toMatchObject(
        {
          projectId: "p1",
          source: "api",
          target: { kind: "server", serverId: "s1" },
        },
      );
    });

    it("refuses a body that tries to name its own target", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/servers/s1/conformance-runs",
        { body: { serverUrl: "https://evil.example.com/mcp" } },
      );
      expect(res.status).toBe(400);
      expect(executePersistedConformanceRunMock).not.toHaveBeenCalled();
    });

    it("refuses oauth in the suite list", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/servers/s1/conformance-runs",
        { body: { suites: ["protocol", "oauth"] } },
      );
      expect(res.status).toBe(400);
      expect(executePersistedConformanceRunMock).not.toHaveBeenCalled();
    });

    it("refuses a server on a transport conformance cannot grade", async () => {
      authorizeServerMock.mockResolvedValue({
        ...HTTP_SERVER,
        serverConfig: { transportType: "stdio" as const },
      });
      const res = await request(
        "POST",
        "/api/v1/projects/p1/servers/s1/conformance-runs",
        { body: {} },
      );
      expect(res.status).toBe(400);
      expect(executePersistedConformanceRunMock).not.toHaveBeenCalled();
    });

    it("forwards an idempotency key as a namespaced externalRunId", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/servers/s1/conformance-runs",
        { body: { idempotencyKey: "k1", suites: ["protocol"] } },
      );
      expect(res.status).toBe(202);
      expect(executePersistedConformanceRunMock.mock.calls[0]![0]).toMatchObject(
        {
          externalRunId: "api:p1:k1",
          suites: ["protocol"],
        },
      );
    });

    it("reports a replayed run's REAL status", async () => {
      executePersistedConformanceRunMock.mockImplementation(async (args: any) => {
        await args.onRunStarted?.("run_1", {
          reused: true,
          status: "completed",
        });
        return { runId: "run_1", reused: true };
      });
      const res = await request(
        "POST",
        "/api/v1/projects/p1/servers/s1/conformance-runs",
        { body: { idempotencyKey: "k1" } },
      );
      expect(res.status).toBe(202);
      const body = (await res.json()) as { status?: string; deduped?: boolean };
      expect(body.status).toBe("completed");
      expect(body.deduped).toBe(true);
    });
  });

  describe("reading a run", () => {
    it("renders the DTO with pending, profile identity, and a relative reportUrl", async () => {
      convexQueryMock.mockResolvedValue(RUN_ROW);
      const res = await request(
        "GET",
        "/api/v1/projects/p1/conformance-runs/run_1",
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, any>;
      expect(body.id).toBe("run_1");
      expect(body.pending).toBe(1);
      expect(body.reports[0].profileId).toBe("mcp-protocol");
      expect(body.reportUrl).toBe(
        "/api/v1/projects/p1/conformance-runs/run_1/report",
      );
    });

    it("404s a run that belongs to another project", async () => {
      convexQueryMock.mockResolvedValue({ ...RUN_ROW, projectId: "p-other" });
      const res = await request(
        "GET",
        "/api/v1/projects/p1/conformance-runs/run_1",
      );
      expect(res.status).toBe(404);
    });

    it("404s a run the caller cannot see", async () => {
      convexQueryMock.mockResolvedValue(null);
      const res = await request(
        "GET",
        "/api/v1/projects/p1/conformance-runs/run_x",
      );
      expect(res.status).toBe(404);
    });

    it("lists through Convex pagination and maps serverId to targetKey", async () => {
      convexQueryMock.mockResolvedValue({
        page: [RUN_ROW],
        isDone: true,
        continueCursor: "",
      });
      const res = await request(
        "GET",
        "/api/v1/projects/p1/conformance-runs?serverId=s1&limit=5",
      );
      expect(res.status).toBe(200);
      expect(convexQueryMock).toHaveBeenCalledWith(
        "conformanceRuns:listRuns",
        expect.objectContaining({
          projectId: "p1",
          targetKey: "server:s1",
          paginationOpts: { cursor: null, numItems: 5 },
        }),
      );
    });
  });

  describe("the report", () => {
    it("404s when there is nothing stored", async () => {
      convexQueryMock.mockResolvedValue({
        ...RUN_ROW,
        reports: [{ suiteKind: "protocol", reportUrl: null }],
      });
      const res = await request(
        "GET",
        "/api/v1/projects/p1/conformance-runs/run_1/report",
      );
      expect(res.status).toBe(404);
    });

    it("projects failing checks, pending first left in place, failed before could-not-run", async () => {
      convexQueryMock.mockResolvedValue(RUN_ROW);
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              profile: {
                profileId: "mcp-protocol",
                profileVersion: "1",
                pendingCheckIds: ["wire-schema-valid"],
              },
              groups: [
                {
                  id: "core",
                  cases: [
                    { id: "ping", title: "ping", status: "passed" },
                    {
                      id: "init-timeout",
                      title: "init",
                      status: "skipped",
                      skipReason: "could-not-run",
                    },
                    {
                      id: "wire-schema-valid",
                      title: "wire",
                      status: "failed",
                      pending: true,
                    },
                    { id: "auth-fail", title: "auth", status: "failed" },
                  ],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const res = await request(
        "GET",
        "/api/v1/projects/p1/conformance-runs/run_1/report",
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, any>;
      expect(body.totalCases).toBe(4);
      expect(body.totalFailingCases).toBe(3);
      expect(body.truncated).toBe(false);
      expect(body.checks.map((check: { id: string }) => check.id)).toEqual([
        "wire-schema-valid",
        "auth-fail",
        "init-timeout",
      ]);
      expect(body.checks[0].pending).toBe(true);
      expect(body.checks[0].groupId).toBe("core");
      expect(body.profiles[0]).toMatchObject({
        suiteKind: "protocol",
        profileId: "mcp-protocol",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://storage.example.com/report.json",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });
});
