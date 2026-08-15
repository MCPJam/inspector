import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Covers the v1 eval-ingestion proxies: project-path injection (`default`
// alias vs explicit id), body/status passthrough in both directions, and
// local input validation. The backend behavior behind the proxy is covered
// by mcpjam-backend's sdkEvalsIngestScope tests.

const { validateGuestTokenMock } = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

import v1Routes from "../index.js";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function request(
  app: Hono,
  path: string,
  body: string,
  token = "tok"
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body,
    })
  );
}

function backendResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("v1 eval-ingest proxies", () => {
  const originalEnv = { CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL };
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalEnv.CONVEX_HTTP_URL) {
      process.env.CONVEX_HTTP_URL = originalEnv.CONVEX_HTTP_URL;
    } else {
      delete process.env.CONVEX_HTTP_URL;
    }
  });

  it("forwards the body to the backend ingest route and passes the response through", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      backendResponse(200, {
        ok: true,
        suiteId: "suite_1",
        runId: "run_1",
        status: "completed",
      })
    );
    global.fetch = fetchMock as never;

    const res = await request(
      makeApp(),
      "/api/v1/projects/default/eval-ingest/report",
      JSON.stringify({ suiteName: "smoke", results: [{ passed: true }] })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, runId: "run_1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://convex-http.example.com/v1/evals/ingest/report"
    );
    expect((init as RequestInit).method).toBe("POST");
    expect(
      (init as { headers: Record<string, string> }).headers.authorization
    ).toBe("Bearer tok");
  });

  it("omits projectId for the `default` alias and overwrites it for explicit ids", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(backendResponse(200, { ok: true }));
    global.fetch = fetchMock as never;

    await request(
      makeApp(),
      "/api/v1/projects/default/eval-ingest/runs/start",
      JSON.stringify({
        suiteName: "s",
        externalRunId: "r1",
        projectId: "smuggled",
      })
    );
    const defaultPayload = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body)
    );
    expect(defaultPayload).not.toHaveProperty("projectId");

    await request(
      makeApp(),
      "/api/v1/projects/jd7abc/eval-ingest/runs/start",
      JSON.stringify({
        suiteName: "s",
        externalRunId: "r1",
        projectId: "smuggled",
      })
    );
    const explicitPayload = JSON.parse(
      String((fetchMock.mock.calls[1][1] as RequestInit).body)
    );
    expect(explicitPayload.projectId).toBe("jd7abc");
  });

  it("passes backend v1 error envelopes through verbatim", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      backendResponse(403, {
        code: "FORBIDDEN",
        message: "API key is not scoped to this organization",
      })
    ) as never;

    const res = await request(
      makeApp(),
      "/api/v1/projects/jd7other/eval-ingest/runs/finalize",
      JSON.stringify({ runId: "run_1", externalRunId: "r1" })
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects malformed JSON locally with a v1 VALIDATION_ERROR", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;

    const res = await request(
      makeApp(),
      "/api/v1/projects/default/eval-ingest/runs/iterations",
      "{not json"
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "VALIDATION_ERROR"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects valid non-object JSON bodies before touching the backend", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;

    for (const body of ["null", "1", '"x"', "[]"]) {
      const res = await request(
        makeApp(),
        "/api/v1/projects/default/eval-ingest/report",
        body
      );
      expect(res.status, body).toBe(400);
      expect(((await res.json()) as { code?: string }).code, body).toBe(
        "VALIDATION_ERROR"
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("covers every ingest suffix the SDK reporter calls", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(backendResponse(200, { ok: true }));
    global.fetch = fetchMock as never;

    const suffixes = [
      "report",
      "runs/start",
      "runs/iterations",
      "runs/finalize",
      "artifacts/upload-url",
    ];
    for (const suffix of suffixes) {
      const res = await request(
        makeApp(),
        `/api/v1/projects/default/eval-ingest/${suffix}`,
        JSON.stringify({})
      );
      expect(res.status, suffix).toBe(200);
    }
    expect(fetchMock).toHaveBeenCalledTimes(suffixes.length);
  });
});

/**
 * The hop this proxy makes is to MCPJam's OWN Convex deployment, so an
 * unrecognized failure is ours. Before the internal-boundary declaration it
 * classified `transport/fetch_failed` -> `ambiguous` and could never reach the
 * MCPJam-fault monitor: measured 2026-08-15 as 44 opaque 500s in 72h with
 * nothing watching them.
 */
describe("v1 eval-ingest — failure attribution", () => {
  const originalEnv = { CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL };
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.CONVEX_HTTP_URL = originalEnv.CONVEX_HTTP_URL;
  });

  it("reports a transport failure against our own Convex without moving the status", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new TypeError("fetch failed")) as never;

    const response = await request(
      makeApp(),
      "/api/v1/projects/default/eval-ingest/report",
      JSON.stringify({ results: [] })
    );
    const body = (await response.json()) as { code?: string; message?: string };

    // 500, NOT 502. `SERVER_UNREACHABLE` means the USER's target MCP server
    // everywhere else here, and #3948 showed that reclassifying a route's
    // status silently blinds monitors keyed on it.
    expect(response.status).toBe(500);
    expect(body.code).toBe("INTERNAL_ERROR");
    // No longer opaque: these rows carried no errorMessage at all before.
    expect(body.message).toContain("fetch failed");
  });

  it("still answers TIMEOUT for an abort rather than claiming a fault", async () => {
    global.fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      })
    ) as never;

    const response = await request(
      makeApp(),
      "/api/v1/projects/default/eval-ingest/report",
      JSON.stringify({ results: [] })
    );
    const body = (await response.json()) as { code?: string };

    expect(body.code).toBe("TIMEOUT");
  });
});

describe("v1 eval-ingest — webErrorMeta reaches the middleware", () => {
  const originalEnv = { CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL };
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.CONVEX_HTTP_URL = originalEnv.CONVEX_HTTP_URL;
  });

  it("promotes a Convex transport failure all the way to origin=mcpjam", async () => {
    // The end-to-end assertion, not a composition guess: boundary promotion ->
    // rethrown WebRouteError -> mapErrorToV1 -> v1Error -> webErrorMeta. Every
    // link is load-bearing and each one has silently dropped the origin before.
    let meta: Record<string, unknown> | undefined;
    const app = new Hono();
    app.use("*", async (c, next) => {
      await next();
      meta = c.get("webErrorMeta" as never) as Record<string, unknown>;
    });
    app.route("/api/v1", v1Routes);

    global.fetch = vi
      .fn()
      .mockRejectedValue(new TypeError("fetch failed")) as never;

    await request(
      app,
      "/api/v1/projects/default/eval-ingest/report",
      JSON.stringify({ results: [] })
    );

    expect(meta).toBeDefined();
    expect(meta).toMatchObject({ origin: "mcpjam" });
    expect(meta).toHaveProperty("slug");
    // And a real message, where the row used to carry none at all.
    expect(String(meta?.message)).toContain("fetch failed");
  });

  it("does NOT claim a caller's own bad input", async () => {
    // Same route, same serializer: a validation 400 must stay unattributed to
    // MCPJam or the monitor pages on someone posting malformed JSON.
    let meta: Record<string, unknown> | undefined;
    const app = new Hono();
    app.use("*", async (c, next) => {
      await next();
      meta = c.get("webErrorMeta" as never) as Record<string, unknown>;
    });
    app.route("/api/v1", v1Routes);

    await request(
      app,
      "/api/v1/projects/default/eval-ingest/report",
      "not json at all"
    );

    expect(meta).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(meta?.origin).not.toBe("mcpjam");
  });
});
