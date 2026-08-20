import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The v1 readiness surface (`server/routes/v1/claude-readiness.ts`).
 *
 * What these pin:
 *
 *   1. THE URL COMES OFF THE SERVER RECORD, never the body. A caller who could
 *      name a URL here would file a grade against a connector the project
 *      never described.
 *   2. THE CROSS-PROJECT GUARDS, in both directions: a server id from another
 *      project cannot become a run, and a run from another project cannot be
 *      read under a URL naming this one. Convex authorizes against the row's
 *      own project, which need not be the one in the path.
 *   3. A REPLAY IS 200, a fresh enqueue is 202. Nothing has been graded at
 *      either point, and a caller retrying after a dropped response has to be
 *      able to tell which happened.
 */

const { queryMock, mutationMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  mutationMock: vi.fn(),
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query(...args: unknown[]) {
      return queryMock(...args);
    }
    mutation(...args: unknown[]) {
      return mutationMock(...args);
    }
  },
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "convex-jwt",
}));

import claudeReadiness from "../claude-readiness.js";
import { v1OnError } from "../envelope.js";

const PROJECT = "proj_a";
const SERVER = "srv_1";
const RUN = "run_1";
const SERVER_URL = "https://mcp.example.com/mcp";

function makeApp() {
  const app = new Hono();
  app.onError(v1OnError);
  app.route("/api/v1", claudeReadiness);
  return app;
}

function request(path: string, init?: RequestInit) {
  return makeApp().request(`/api/v1${path}`, init);
}

function savedServer(overrides: Record<string, unknown> = {}) {
  return [{ _id: SERVER, url: SERVER_URL, transportType: "http", ...overrides }];
}

beforeEach(() => {
  // `createConvexClient` fails closed with a 500 when this is unset, which is
  // correct in production and would make every case here a 500.
  vi.stubEnv("CONVEX_URL", "https://convex.test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  // NOT covered by the mock resets: the report tests stub the global `fetch`,
  // and a stub that survives into the next test silently answers a request
  // that was meant to reach nothing.
  vi.unstubAllGlobals();
  queryMock.mockReset();
  mutationMock.mockReset();
});

describe("POST …/servers/:serverId/claude-readiness-runs", () => {
  it("grades the URL on the server record", async () => {
    queryMock.mockResolvedValue(savedServer());
    mutationMock.mockResolvedValue({
      runId: RUN,
      jobId: "job-1",
      reused: false,
    });

    const response = await request(
      `/projects/${PROJECT}/servers/${SERVER}/claude-readiness-runs`,
      { method: "POST" },
    );

    expect(response.status).toBe(202);
    const [name, args] = mutationMock.mock.calls[0]!;
    expect(name).toBe("claudeReadinessRuns:requestReadinessRun");
    expect(args).toMatchObject({
      projectId: PROJECT,
      serverId: SERVER,
      serverUrl: SERVER_URL,
      authMode: "headless",
      capabilities: ["dns", "raw-origin"],
    });
  });

  it("never returns the job id, which is the executing node's lease", async () => {
    queryMock.mockResolvedValue(savedServer());
    mutationMock.mockResolvedValue({
      runId: RUN,
      jobId: "job-secret",
      reused: false,
    });

    const body = await (
      await request(
        `/projects/${PROJECT}/servers/${SERVER}/claude-readiness-runs`,
        { method: "POST" },
      )
    ).json();

    expect(body).toMatchObject({ id: RUN, status: "pending" });
    expect(JSON.stringify(body)).not.toContain("job-secret");
  });

  it("answers 200 on an idempotent replay, 202 on a fresh enqueue", async () => {
    queryMock.mockResolvedValue(savedServer());
    mutationMock.mockResolvedValue({
      runId: RUN,
      jobId: "job-1",
      reused: true,
    });

    const response = await request(
      `/projects/${PROJECT}/servers/${SERVER}/claude-readiness-runs`,
      {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: "abc" }),
        headers: { "content-type": "application/json" },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reused: true });
    expect(mutationMock.mock.calls[0]![1]).toMatchObject({
      idempotencyKey: "abc",
    });
  });

  it("404s a server that belongs to another project", async () => {
    // Same answer as a server that does not exist — anything else is an
    // existence oracle for other people's projects.
    queryMock.mockResolvedValue([{ _id: "srv_other", url: SERVER_URL }]);

    const response = await request(
      `/projects/${PROJECT}/servers/${SERVER}/claude-readiness-runs`,
      { method: "POST" },
    );

    expect(response.status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("refuses a server with no URL to grade", async () => {
    queryMock.mockResolvedValue(savedServer({ url: undefined }));

    const response = await request(
      `/projects/${PROJECT}/servers/${SERVER}/claude-readiness-runs`,
      { method: "POST" },
    );

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(/remote connector/i);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown body field rather than ignoring it", async () => {
    // A caller passing `serverUrl` believes they chose the target. Silently
    // dropping it would grade something else and call it their run.
    queryMock.mockResolvedValue(savedServer());

    const response = await request(
      `/projects/${PROJECT}/servers/${SERVER}/claude-readiness-runs`,
      {
        method: "POST",
        body: JSON.stringify({ serverUrl: "https://attacker.example/mcp" }),
        headers: { "content-type": "application/json" },
      },
    );

    expect(response.status).toBe(400);
    expect(mutationMock).not.toHaveBeenCalled();
  });
});

describe("GET …/claude-readiness-runs/:runId", () => {
  it("404s a run whose project is not the one in the path", async () => {
    // Convex authorizes against the RUN's project, which need not be the one
    // the URL names. A client that trusts its own URL would file it wrong.
    queryMock.mockResolvedValue({ id: RUN, projectId: "proj_b" });

    const response = await request(
      `/projects/${PROJECT}/claude-readiness-runs/${RUN}`,
    );
    expect(response.status).toBe(404);
  });

  it("returns the run when the project matches", async () => {
    queryMock.mockResolvedValue({
      id: RUN,
      projectId: PROJECT,
      status: "completed",
      overallStatus: "not-ready",
    });

    const response = await request(
      `/projects/${PROJECT}/claude-readiness-runs/${RUN}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: RUN,
      overallStatus: "not-ready",
    });
  });

  it("404s a run that does not exist", async () => {
    queryMock.mockResolvedValue(null);
    const response = await request(
      `/projects/${PROJECT}/claude-readiness-runs/${RUN}`,
    );
    expect(response.status).toBe(404);
  });
});

describe("GET …/claude-readiness-runs/:runId/report", () => {
  /** Route the two Convex queries this endpoint makes, by name. */
  function mockReport(args: {
    run?: Record<string, unknown> | null;
    located?: { url: string } | null;
  }) {
    queryMock.mockImplementation(async (name: string) =>
      String(name).endsWith("getReadinessReportUrl")
        ? (args.located ?? null)
        : args.run === undefined
          ? { id: RUN, projectId: PROJECT }
          : args.run,
    );
  }

  it("streams the stored report through rather than the storage URL", async () => {
    // The URL is a bearer capability for as long as it lives. Handing one back
    // would turn an authorized read into a link that outlives the
    // authorization — and one that does not go through this route's guards.
    const report = { status: "not-ready", findings: [{ id: "a" }] };
    mockReport({ located: { url: "https://storage.test/blob-1" } });
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(report), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await request(
      `/projects/${PROJECT}/claude-readiness-runs/${RUN}/report`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(report);
    expect(fetchMock).toHaveBeenCalledOnce();
    // Nothing in the response names where the bytes came from.
    expect(JSON.stringify(response.headers)).not.toContain("storage.test");
  });

  it("never lets a shared cache hold one project's report", async () => {
    mockReport({ located: { url: "https://storage.test/blob-1" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const response = await request(
      `/projects/${PROJECT}/claude-readiness-runs/${RUN}/report`,
    );
    expect(response.headers.get("cache-control")).toMatch(/private/);
    expect(response.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("404s a swept report rather than serving an empty one", async () => {
    // Retention drops the blob and keeps the row, so this is a normal answer
    // about an old run. Returning `{}` would let a caller read "no findings"
    // out of "the findings are gone".
    mockReport({ located: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await request(
      `/projects/${PROJECT}/claude-readiness-runs/${RUN}/report`,
    );
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks the project BEFORE asking for a URL", async () => {
    // The Convex query authorizes on the run's own project. Without this guard
    // a report is readable through a URL naming an unrelated project — and
    // asking for the URL first would mint a capability for a request that is
    // about to 404 anyway.
    const located = vi.fn();
    queryMock.mockImplementation(async (name: string) => {
      if (String(name).endsWith("getReadinessReportUrl")) return located();
      return { id: RUN, projectId: "proj_b" };
    });

    const response = await request(
      `/projects/${PROJECT}/claude-readiness-runs/${RUN}/report`,
    );
    expect(response.status).toBe(404);
    expect(located).not.toHaveBeenCalled();
  });

  it("refuses a body larger than it will serve", async () => {
    // This streams into the caller's response. An unbounded read of an
    // unbounded object is how one request takes a node's memory with it.
    mockReport({ located: { url: "https://storage.test/blob-1" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("x".repeat(5 * 1024 * 1024), { status: 200 }),
      ),
    );
    const response = await request(
      `/projects/${PROJECT}/claude-readiness-runs/${RUN}/report`,
    );
    expect(response.status).toBe(500);
  });

  it("reports a storage outage as OURS, not as the connector's", async () => {
    // 500, not the 502 SERVER_UNREACHABLE this file's other failures use.
    // That code means the graded connector could not be reached; storage is
    // our own infrastructure, and saying 502 would send someone to go and
    // look at a server that is working fine.
    mockReport({ located: { url: "https://storage.test/blob-1" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection reset");
      }),
    );
    const response = await request(
      `/projects/${PROJECT}/claude-readiness-runs/${RUN}/report`,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
  });
});

describe("GET …/claude-readiness-runs", () => {
  it("forwards the server filter and the limit", async () => {
    queryMock.mockResolvedValue([{ id: RUN }]);

    const response = await request(
      `/projects/${PROJECT}/claude-readiness-runs?serverId=${SERVER}&limit=5`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ id: RUN }] });
    expect(queryMock.mock.calls[0]![1]).toMatchObject({
      projectId: PROJECT,
      serverId: SERVER,
      limit: 5,
    });
  });

  it("rejects a non-numeric limit instead of silently ignoring it", async () => {
    const response = await request(
      `/projects/${PROJECT}/claude-readiness-runs?limit=lots`,
    );
    expect(response.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("POST …/claude-readiness-runs/:runId/cancel", () => {
  it("cancels through Convex, which clears the lease", async () => {
    queryMock.mockResolvedValue({ id: RUN, projectId: PROJECT });
    mutationMock.mockResolvedValue({ cancelled: true });

    const response = await request(
      `/projects/${PROJECT}/claude-readiness-runs/${RUN}/cancel`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: RUN, cancelled: true });
    expect(mutationMock.mock.calls[0]![0]).toBe(
      "claudeReadinessRuns:cancelReadinessRun",
    );
  });

  it("reports a run that had already stopped as a conflict, not bad input", async () => {
    queryMock.mockResolvedValue({ id: RUN, projectId: PROJECT });
    const error = Object.assign(new Error("This readiness run is not in progress"), {
      data: { code: "CONFLICT", message: "This readiness run is not in progress" },
    });
    mutationMock.mockRejectedValue(error);

    const response = await request(
      `/projects/${PROJECT}/claude-readiness-runs/${RUN}/cancel`,
      { method: "POST" },
    );
    expect(response.status).toBe(409);
  });
});

describe("the bounds a documented API owes its callers", () => {
  it("rejects a limit above the page ceiling instead of silently clamping", async () => {
    // Convex clamps, which is right for a query and wrong for a documented
    // API: a caller who asked for 500 and got 100 has no way to tell.
    const response = await request(
      `/projects/${PROJECT}/claude-readiness-runs?limit=101`,
    );
    expect(response.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("accepts the ceiling itself", async () => {
    queryMock.mockResolvedValue([]);
    const response = await request(
      `/projects/${PROJECT}/claude-readiness-runs?limit=100`,
    );
    expect(response.status).toBe(200);
  });

  it("rejects a body that is not JSON", async () => {
    queryMock.mockResolvedValue(savedServer());
    const response = await request(
      `/projects/${PROJECT}/servers/${SERVER}/claude-readiness-runs`,
      {
        method: "POST",
        body: "{not json",
        headers: { "content-type": "application/json" },
      },
    );
    expect(response.status).toBe(400);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("refuses to cancel a run belonging to another project", async () => {
    // The sibling GET already refuses this. Without the same check here, a run
    // can be stopped through a URL naming a project it has nothing to do with.
    queryMock.mockResolvedValue({ id: RUN, projectId: "proj_b" });

    const response = await request(
      `/projects/${PROJECT}/claude-readiness-runs/${RUN}/cancel`,
      { method: "POST" },
    );

    expect(response.status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });
});
