/**
 * The hosted readiness routes the conformance panel calls.
 *
 * These are the SAME durable runs `/api/v1` starts — the shared starter is
 * what makes that true rather than a comment claiming it — so what this file
 * guards is the part that is NOT shared: who may reach them, what a start is
 * allowed to say, and that a start answers with a receipt rather than a grade.
 *
 * The refusals matter more than the happy paths here. Three of them protect
 * something a passing test cannot: a guest has no organization to bill and no
 * project to own the row; an OpenAI run with no declared submission shape
 * reports its package lane `not-applicable`, turning a missing input into a
 * clean bill of health; and a start that answered synchronously would make the
 * browser tab's lifetime the run's lifetime.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const authorizeServerMock = vi.hoisted(() => vi.fn());
const startHostedReadinessRunMock = vi.hoisted(() => vi.fn());
const convexQueryMock = vi.hoisted(() => vi.fn());
const convexMutationMock = vi.hoisted(() => vi.fn());
const guestIdRef = vi.hoisted(() => ({
  current: undefined as string | undefined,
}));

vi.mock("../auth.js", async () => {
  const { z } = await import("zod");
  return {
    handleRoute: async (c: any, handler: () => Promise<any>, status = 200) => {
      try {
        return c.json(await handler(), status);
      } catch (error: any) {
        return c.json(
          { code: error?.code ?? "INTERNAL_ERROR", message: error?.message },
          error?.status ?? 500,
        );
      }
    },
    projectServerSchema: z
      .object({ projectId: z.string(), serverId: z.string() })
      .passthrough(),
    authorizeServer: authorizeServerMock,
    toHttpConfig: () => ({ url: "https://mcp.example.test/mcp" }),
  };
});

vi.mock("../../shared/readiness-runs.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../shared/readiness-runs.js")
  >("../../shared/readiness-runs.js");
  return { ...actual, startHostedReadinessRun: startHostedReadinessRunMock };
});

vi.mock("../../shared/conformance", () => ({
  runProtocolConformance: vi.fn(),
  startOAuthConformance: vi.fn(),
  runTasksConformance: vi.fn(),
  runAppsConformance: vi.fn(),
  completeOAuthConformance: vi.fn(),
  submitOAuthConformanceCode: vi.fn(),
  UnsupportedTransportError: class extends Error {},
  OAuthConformanceSessionNotFoundError: class extends Error {},
  OAuthConformanceSessionFailedError: class extends Error {},
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query = convexQueryMock;
    mutation = convexMutationMock;
  },
}));

vi.mock("../../../services/evals/route-helpers.js", () => ({
  createConvexClient: () => ({
    setAuth() {},
    query: convexQueryMock,
    mutation: convexMutationMock,
  }),
  requireConvexHttpUrl: () => "https://convex.test",
}));

vi.mock("../../../services/internal-backend.js", () => ({
  getInternalBackendConfig: () => ({
    convexUrl: "https://convex.site.test",
    serviceToken: "service-token",
  }),
}));

vi.mock("../../../utils/hosted-egress-guard.js", () => ({
  assertAllowedHostedTargetUrl: vi.fn().mockResolvedValue(undefined),
  BlockedEgressTargetError: class extends Error {},
  EgressResolutionError: class extends Error {},
}));

async function call(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
) {
  const { default: conformanceWeb } = await import("../conformance.js");
  // The guest id normally arrives from `bearerAuthMiddleware`; setting it in a
  // wrapper is how a test reaches the same context key without standing up the
  // whole auth stack.
  const app = new (await import("hono")).Hono();
  app.use("*", async (c, next) => {
    if (guestIdRef.current)
      c.set("guestId" as never, guestIdRef.current as never);
    await next();
  });
  app.route("/", conformanceWeb);
  return app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const AUTHORIZED = {
  serverConfig: {
    transportType: "http" as const,
    url: "https://mcp.example.test/mcp",
  },
};

const START_BODY = { projectId: "p1", serverId: "s1" };

describe("POST /conformance/readiness/:publisher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guestIdRef.current = undefined;
    process.env.CONVEX_URL = "https://convex.test";
    authorizeServerMock.mockResolvedValue(AUTHORIZED);
    startHostedReadinessRunMock.mockResolvedValue({
      runId: "run_1",
      projectId: "p1",
      serverId: "s1",
      readinessKind: "claude",
      status: "pending",
      deduped: false,
      includeLlmObservations: false,
    });
  });

  it("answers 202 with a run id, never a grade", async () => {
    // A readiness run walks a redirect chain, discovers auth metadata and
    // lists tools. A synchronous answer would make the browser's timeout the
    // run's timeout, and a closed tab would strand a lease.
    const res = await call("POST", "/readiness/claude", START_BODY);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { run: { runId: string } };
    expect(body.run.runId).toBe("run_1");
  });

  it("refuses a publisher outside the two vocabulary words", async () => {
    const res = await call("POST", "/readiness/gemini", START_BODY);
    expect(res.status).toBe(400);
    expect(startHostedReadinessRunMock).not.toHaveBeenCalled();
  });

  it("refuses a guest before anything is created, charged or dialled", async () => {
    // Not a rate-limiting decision. A guest identity is free to mint and
    // belongs to no organization, so there is no honest answer to "who pays
    // for this and who owns the result".
    guestIdRef.current = "guest_1";
    const res = await call("POST", "/readiness/claude", START_BODY);
    expect(res.status).toBe(403);
    expect(authorizeServerMock).not.toHaveBeenCalled();
    expect(startHostedReadinessRunMock).not.toHaveBeenCalled();
  });

  it("refuses an OpenAI run that declares no submission mode", async () => {
    const res = await call("POST", "/readiness/openai", START_BODY);
    expect(res.status).toBe(400);
    expect(startHostedReadinessRunMock).not.toHaveBeenCalled();
  });

  it("accepts an OpenAI run that declares one", async () => {
    const res = await call("POST", "/readiness/openai", {
      ...START_BODY,
      submissionMode: "mcp-imported-skills",
    });
    expect(res.status).toBe(202);
    expect(startHostedReadinessRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        publisher: "openai",
        submissionMode: "mcp-imported-skills",
      }),
    );
  });

  it("refuses a package submission mode, which no hosted surface can receive", async () => {
    // The archive lives on the caller's disk and the CLI is where it is read.
    // Accepting the word here would produce a run whose package lane can never
    // evaluate.
    const res = await call("POST", "/readiness/openai", {
      ...START_BODY,
      submissionMode: "mcp-uploaded-skills",
    });
    expect(res.status).toBe(400);
    expect(startHostedReadinessRunMock).not.toHaveBeenCalled();
  });

  it("defaults the billed opt-in OFF when the body does not mention it", async () => {
    // The one field that can spend. A default of true would make every
    // existing caller start paying on the day this shipped.
    await call("POST", "/readiness/claude", START_BODY);
    expect(startHostedReadinessRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ includeLlmObservations: false }),
    );
  });

  it("passes the opt-in through when it is asked for explicitly", async () => {
    await call("POST", "/readiness/claude", {
      ...START_BODY,
      includeLlmObservations: true,
    });
    expect(startHostedReadinessRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ includeLlmObservations: true }),
    );
  });

  it("takes the target from the AUTHORIZED row, never from the body", async () => {
    // A body field that could name a host would make this an authenticated
    // fetch primitive pointed at anything the network can reach.
    await call("POST", "/readiness/claude", {
      ...START_BODY,
      serverUrl: "https://attacker.test/mcp",
    });
    const [call0] = startHostedReadinessRunMock.mock.calls;
    expect(call0![0].authorized).toBe(AUTHORIZED);
    expect(JSON.stringify(call0![0])).not.toContain("attacker.test");
  });
});

describe("GET /conformance/readiness/runs/:runId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guestIdRef.current = undefined;
    process.env.CONVEX_URL = "https://convex.test";
  });

  it("requires a projectId", async () => {
    const res = await call("GET", "/readiness/runs/run_1");
    expect(res.status).toBe(400);
    expect(convexQueryMock).not.toHaveBeenCalled();
  });

  it("projects the row, observation axis included", async () => {
    convexQueryMock.mockResolvedValue({
      id: "run_1",
      readinessKind: "claude",
      status: "completed",
      overallStatus: "ready",
      lanes: [],
      llmObservations: {
        status: "billing-blocked",
        reason: "billing_limit_reached",
      },
      hasReport: true,
      createdAt: 1,
      updatedAt: 2,
    });
    const res = await call("GET", "/readiness/runs/run_1?projectId=p1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: any };
    // A run whose lanes graded cleanly is `completed` even when the model call
    // was refused for credit. Folding the two would make a billing outage read
    // as a grading failure.
    expect(body.run.status).toBe("completed");
    expect(body.run.llmObservations.reason).toBe("billing_limit_reached");
  });

  it("404s a run the caller cannot see", async () => {
    convexQueryMock.mockResolvedValue(null);
    const res = await call("GET", "/readiness/runs/run_x?projectId=p1");
    expect(res.status).toBe(404);
  });

  it("refuses a guest", async () => {
    guestIdRef.current = "guest_1";
    const res = await call("GET", "/readiness/runs/run_1?projectId=p1");
    expect(res.status).toBe(403);
    expect(convexQueryMock).not.toHaveBeenCalled();
  });
});

describe("POST /conformance/readiness/runs/:runId/cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guestIdRef.current = undefined;
    process.env.CONVEX_URL = "https://convex.test";
  });

  it("cancels through the caller's own identity", async () => {
    convexMutationMock.mockResolvedValue(undefined);
    const res = await call("POST", "/readiness/runs/run_1/cancel", {});
    expect(res.status).toBe(200);
    expect(convexMutationMock).toHaveBeenCalledWith(
      "claudeReadinessRuns:cancelReadinessRun",
      { runId: "run_1" },
    );
  });

  it("refuses a guest", async () => {
    guestIdRef.current = "guest_1";
    const res = await call("POST", "/readiness/runs/run_1/cancel", {});
    expect(res.status).toBe(403);
    expect(convexMutationMock).not.toHaveBeenCalled();
  });
});

/**
 * The report route, which is the only one of the four that BYPASSES
 * `handleRoute`.
 *
 * Its success path returns raw bytes rather than a JSON envelope, so its error
 * path has to reach the same mapper by hand — exactly the kind of hand-wired
 * seam that rots silently. It also double-gates: the caller's own identity
 * resolves the blob id, and only then does a service token read the bytes.
 */
describe("GET /conformance/readiness/runs/:runId/report", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    guestIdRef.current = undefined;
    process.env.CONVEX_URL = "https://convex.test";
  });

  it("refuses a guest before either gate runs", async () => {
    guestIdRef.current = "guest_1";
    const res = await call("GET", "/readiness/runs/run_1/report");
    expect(res.status).toBe(403);
    expect(convexQueryMock).not.toHaveBeenCalled();
  });

  it("404s when the run has no stored report", async () => {
    // Not a missing RUN: it may be in flight, it may have failed, or its
    // report may have aged past retention. Saying which is the run detail's
    // job; this only says there is nothing to fetch.
    convexQueryMock.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await call("GET", "/readiness/runs/run_1/report");
    expect(res.status).toBe(404);
    // THE SECOND GATE NEVER OPENED. A blob read that happened anyway would
    // mean the caller's authorization was decorative.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams the bytes through when both gates pass", async () => {
    convexQueryMock.mockResolvedValue("blob_1");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await call("GET", "/readiness/runs/run_1/report");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready" });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers["x-inspector-service-token"]).toBe("service-token");
  });

  it("maps a backend 404 to 404 rather than to a storage fault", async () => {
    convexQueryMock.mockResolvedValue("blob_1");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 404 })),
    );
    const res = await call("GET", "/readiness/runs/run_1/report");
    expect(res.status).toBe(404);
  });

  it("maps any other backend failure to 502, in an error envelope", async () => {
    // The success path returns raw bytes, so this route serializes its own
    // errors. A regression there would surface as an empty 200.
    convexQueryMock.mockResolvedValue("blob_1");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 500 })),
    );
    const res = await call("GET", "/readiness/runs/run_1/report");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { message?: string };
    expect(String(body.message)).toMatch(/could not be read/i);
  });

  it("maps a transport failure to 502 too", async () => {
    convexQueryMock.mockResolvedValue("blob_1");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const res = await call("GET", "/readiness/runs/run_1/report");
    expect(res.status).toBe(502);
  });
});
