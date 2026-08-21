/**
 * The public readiness surface: what a caller may say, and what it may not.
 *
 * Convex is mocked at the `convex/browser` boundary, so these prove the
 * GATEWAY's behaviour and the args it forwards — not the backend's own checks,
 * which are tested there.
 *
 * The cases worth writing are the ones where a plausible gateway is wrong:
 *
 *   1. A BODY CANNOT CHOOSE THE TARGET OR THE PAYER. The URL names a project
 *      and a saved server; the bearer names an actor. A body that tried to
 *      supply a URL is a 400, not a silently-ignored field.
 *   2. THE PAID OPT-IN DEFAULTS OFF, and is forwarded verbatim. A start that
 *      defaulted it on would begin charging every existing caller.
 *   3. `submissionMode` IS REQUIRED FOR OPENAI and refused for the shapes a
 *      hosted run cannot receive.
 *   4. A REPLAY EXECUTES NOTHING. The run it names is already in flight.
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
  executeHostedReadinessRunMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  validateApiKeyMock: vi.fn(),
  resolveUserByExternalIdMock: vi.fn(),
  lookupWorkosKeyBindingMock: vi.fn(),
  convexQueryMock: vi.fn(),
  convexMutationMock: vi.fn(),
  authorizeServerMock: vi.fn(),
  executeHostedReadinessRunMock: vi.fn(),
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
vi.mock("../../../services/readiness/worker.js", () => ({
  executeHostedReadinessRun: executeHostedReadinessRunMock,
}));

// `authorizeServer` is the one piece the route delegates its TARGET resolution
// to, and mocking it is what proves the target is read from the saved server
// rather than from anything the caller sent.
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
  id: "run_1",
  readinessKind: "claude",
  serverUrl: "https://connector.example.com/mcp",
  status: "completed",
  overallStatus: "incomplete",
  lanes: [
    {
      lane: "directory-policy",
      status: "incomplete",
      evaluated: 2,
      notEvaluated: 1,
      notApplicable: 0,
      missingInputs: ["toolListing"],
    },
  ],
  stages: [],
  capabilities: [],
  attemptCount: 1,
  includeLlmObservations: true,
  llmObservations: {
    status: "billing-blocked",
    reason: "billing_limit_reached",
    detail: "out of credits",
  },
  hasReport: true,
  createdAt: 1,
  updatedAt: 2,
};

describe("v1 directory readiness", () => {
  const originalEnv = {
    CONVEX_URL: process.env.CONVEX_URL,
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
    INSPECTOR_SERVICE_TOKEN: process.env.INSPECTOR_SERVICE_TOKEN,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    authorizeServerMock.mockResolvedValue(HTTP_SERVER);
    convexMutationMock.mockResolvedValue({
      runId: "run_1",
      jobId: "job_1",
      reused: false,
    });
    executeHostedReadinessRunMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Globals too, not just the environment. A stubbed `fetch` restored on the
    // last line of a test body leaks into every test after it the moment an
    // assertion above that line fails — turning one failure into a cascade
    // whose cause is nowhere near the test that reports it.
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
        "/api/v1/projects/p1/servers/s1/readiness-runs/claude",
        { token: null },
      );
      expect(res.status).toBe(401);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("denies guest callers", async () => {
      validateGuestTokenMock.mockResolvedValue({
        valid: true,
        guestId: "guest_1",
      });
      const res = await request(
        "POST",
        "/api/v1/projects/p1/servers/s1/readiness-runs/claude",
        { token: "guest-jwt" },
      );
      expect(res.status).toBe(401);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });

  describe("starting a Claude run", () => {
    it("answers 202 and detaches execution against the SAVED server's URL", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/servers/s1/readiness-runs/claude",
        { body: {} },
      );
      expect(res.status).toBe(202);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        runId: "run_1",
        readinessKind: "claude",
        includeLlmObservations: false,
      });

      // The URL the run grades comes from `authorizeServer`, never from a body.
      expect(convexMutationMock).toHaveBeenCalledWith(
        "claudeReadinessRuns:requestReadinessRun",
        expect.objectContaining({
          projectId: "p1",
          serverId: "s1",
          serverUrl: "https://connector.example.com/mcp",
          readinessKind: "claude",
          includeLlmObservations: false,
        }),
      );
      expect(executeHostedReadinessRunMock).toHaveBeenCalledTimes(1);
      expect(executeHostedReadinessRunMock.mock.calls[0]![0]).toMatchObject({
        lease: { runId: "run_1", jobId: "job_1" },
        target: "https://connector.example.com/mcp",
        includeLlmObservations: false,
      });
    });

    it("refuses a body that tries to name its own target", async () => {
      // Not silently ignored: a caller that believed it had chosen a target
      // should find out.
      const res = await request(
        "POST",
        "/api/v1/projects/p1/servers/s1/readiness-runs/claude",
        { body: { serverUrl: "https://evil.example.com/mcp" } },
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("refuses a body that tries to name a payer", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/servers/s1/readiness-runs/claude",
        { body: { organizationId: "org_other" } },
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("forwards the paid opt-in verbatim when the caller asks for it", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/servers/s1/readiness-runs/claude",
        { body: { includeLlmObservations: true } },
      );
      expect(res.status).toBe(202);
      expect(convexMutationMock).toHaveBeenCalledWith(
        "claudeReadinessRuns:requestReadinessRun",
        expect.objectContaining({ includeLlmObservations: true }),
      );
      expect(executeHostedReadinessRunMock.mock.calls[0]![0]).toMatchObject({
        includeLlmObservations: true,
      });
    });

    it("refuses a server on a transport no directory can list", async () => {
      authorizeServerMock.mockResolvedValue({
        ...HTTP_SERVER,
        serverConfig: { transportType: "stdio" as const },
      });
      const res = await request(
        "POST",
        "/api/v1/projects/p1/servers/s1/readiness-runs/claude",
        { body: {} },
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("EXECUTES NOTHING on an idempotent replay", async () => {
      // The run it names is already in flight or already finished. Starting a
      // second execution would dial a third party's server twice for one
      // logical request — the exact thing the key was sent to prevent.
      convexMutationMock.mockResolvedValue({
        runId: "run_1",
        jobId: "job_1",
        reused: true,
      });
      const res = await request(
        "POST",
        "/api/v1/projects/p1/servers/s1/readiness-runs/claude",
        { body: { idempotencyKey: "k1" } },
      );
      expect(res.status).toBe(202);
      expect(((await res.json()) as { deduped?: boolean }).deduped).toBe(true);
      expect(executeHostedReadinessRunMock).not.toHaveBeenCalled();
    });

    it("reports a replayed run's REAL status, not a decorative pending", async () => {
      // A key replayed hours later names a run that finished long ago.
      // Answering `pending` for it sends the caller into a poll loop for a
      // result it could already read.
      convexMutationMock.mockResolvedValue({
        runId: "run_1",
        jobId: "job_1",
        reused: true,
      });
      convexQueryMock.mockResolvedValue({ id: "run_1", status: "completed" });
      const res = await request(
        "POST",
        "/api/v1/projects/p1/servers/s1/readiness-runs/claude",
        { body: { idempotencyKey: "k1" } },
      );
      expect(res.status).toBe(202);
      expect(((await res.json()) as { status?: string }).status).toBe(
        "completed",
      );
    });

    it("falls back to pending when the replayed run cannot be read", async () => {
      // Failing to read the status is not failing to start. The caller polls,
      // which is what it would have done anyway.
      convexMutationMock.mockResolvedValue({
        runId: "run_1",
        jobId: "job_1",
        reused: true,
      });
      convexQueryMock.mockRejectedValue(new Error("convex is down"));
      const res = await request(
        "POST",
        "/api/v1/projects/p1/servers/s1/readiness-runs/claude",
        { body: { idempotencyKey: "k1" } },
      );
      expect(res.status).toBe(202);
      const body = (await res.json()) as { status?: string; deduped?: boolean };
      expect(body.status).toBe("pending");
      expect(body.deduped).toBe(true);
    });
  });

  describe("starting an OpenAI run", () => {
    it("requires a declared submission mode", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/servers/s1/readiness-runs/openai",
        { body: {} },
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it.each(["skills-only", "mcp-uploaded-skills"])(
      "refuses %s, which needs an upload this API cannot receive",
      async (submissionMode) => {
        const res = await request(
          "POST",
          "/api/v1/projects/p1/servers/s1/readiness-runs/openai",
          { body: { submissionMode } },
        );
        expect(res.status).toBe(400);
        expect(convexMutationMock).not.toHaveBeenCalled();
      },
    );

    it("forwards the declared shape to the run and the worker", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/servers/s1/readiness-runs/openai",
        { body: { submissionMode: "mcp-imported-skills" } },
      );
      expect(res.status).toBe(202);
      expect(convexMutationMock).toHaveBeenCalledWith(
        "claudeReadinessRuns:requestReadinessRun",
        expect.objectContaining({
          readinessKind: "openai",
          submissionMode: "mcp-imported-skills",
        }),
      );
      expect(executeHostedReadinessRunMock.mock.calls[0]![0]).toMatchObject({
        publisher: "openai",
        submissionMode: "mcp-imported-skills",
      });
    });
  });

  describe("reading a run", () => {
    it("renders the DTO with the observation axis beside the verdict", async () => {
      convexQueryMock.mockResolvedValue(RUN_ROW);
      const res = await request("GET", "/api/v1/projects/p1/readiness-runs/run_1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, any>;
      // Completed AND billing-blocked at once: the two axes are independent,
      // and a reader has to be able to see both.
      expect(body.status).toBe("completed");
      expect(body.overallStatus).toBe("incomplete");
      expect(body.llmObservations.reason).toBe("billing_limit_reached");
      expect(body.lanes[0].missingInputs).toEqual(["toolListing"]);
      expect(body.reportUrl).toContain("/readiness-runs/run_1/report");
    });

    it("404s a run the caller cannot see", async () => {
      convexQueryMock.mockResolvedValue(null);
      const res = await request("GET", "/api/v1/projects/p1/readiness-runs/run_x");
      expect(res.status).toBe(404);
    });

    it("narrows a listing by publisher", async () => {
      convexQueryMock.mockResolvedValue([RUN_ROW]);
      const res = await request(
        "GET",
        "/api/v1/projects/p1/readiness-runs?readinessKind=openai&limit=5",
      );
      expect(res.status).toBe(200);
      expect(convexQueryMock).toHaveBeenCalledWith(
        "claudeReadinessRuns:listReadinessRuns",
        { projectId: "p1", readinessKind: "openai", limit: 5 },
      );
    });

    it("refuses a publisher outside the two vocabulary words", async () => {
      const res = await request(
        "GET",
        "/api/v1/projects/p1/readiness-runs?readinessKind=gemini",
      );
      expect(res.status).toBe(400);
      expect(convexQueryMock).not.toHaveBeenCalled();
    });
  });

  describe("cancelling", () => {
    it("forwards the cancellation and reports it", async () => {
      convexMutationMock.mockResolvedValue(null);
      const res = await request(
        "POST",
        "/api/v1/projects/p1/readiness-runs/run_1/cancel",
      );
      expect(res.status).toBe(200);
      expect(convexMutationMock).toHaveBeenCalledWith(
        "claudeReadinessRuns:cancelReadinessRun",
        { runId: "run_1" },
      );
    });
  });

  describe("the report", () => {
    it("404s when there is nothing stored", async () => {
      // Not a missing RUN: it may be in flight, it may have failed, or its
      // report may have aged past retention. Saying which is the run detail's
      // job.
      convexQueryMock.mockResolvedValue(null);
      const res = await request(
        "GET",
        "/api/v1/projects/p1/readiness-runs/run_1/report",
      );
      expect(res.status).toBe(404);
    });

    it("streams the report after the authenticated blob-id lookup", async () => {
      // The QUERY runs under the caller's identity and enforces the project
      // role; only then does the service-token fetch happen.
      convexQueryMock.mockResolvedValue("blob_1");
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ findings: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const res = await request(
        "GET",
        "/api/v1/projects/p1/readiness-runs/run_1/report",
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ findings: [] });
      expect(convexQueryMock).toHaveBeenCalledWith(
        "claudeReadinessRuns:getReadinessReportBlobId",
        { runId: "run_1" },
      );
      const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, any];
      // A RUN id, not a blob id — a service-token route that took a blob id
      // could be used to read any blob in the deployment.
      expect(String(url)).toContain("runId=run_1");
      expect(init.headers["x-inspector-service-token"]).toBe("service-token");
    });
  });
});
