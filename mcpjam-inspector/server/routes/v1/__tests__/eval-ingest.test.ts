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
 * The measured blind spot (2026-08-15): 44 rows on this route in 72h carried
 * `internal_error` 500 with no message, no slug, and no origin, so the
 * MCPJam-fault monitor could never see them.
 *
 * `v1OnError` declares `mcpjam_internal` for the whole v1 router, and that
 * declaration applies to the UNCLASSIFIED 5xx only — `INTERNAL_ERROR` is the
 * one code asserting nothing about a hop. These pin both halves of that rule
 * on the route the measurement came from.
 */
describe("v1 eval-ingest — failure attribution", () => {
  const originalEnv = { CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL };
  const originalFetch = global.fetch;

  function appCapturingMeta(): { app: Hono; meta: () => unknown } {
    let captured: unknown;
    const app = new Hono();
    app.use("*", async (c, next) => {
      await next();
      captured = c.get("webErrorMeta" as never);
    });
    app.route("/api/v1", v1Routes);
    return { app, meta: () => captured };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.CONVEX_HTTP_URL = originalEnv.CONVEX_HTTP_URL;
  });

  it("owns an unclassified 500 — the exact class that was invisible", async () => {
    // End-to-end, not a composition guess: boundary promotion -> mapErrorToV1
    // -> v1OnError -> webErrorMeta. Every link has silently dropped the origin
    // at some point in this program's history.
    global.fetch = vi.fn().mockRejectedValue(new Error("boom")) as never;
    const { app, meta } = appCapturingMeta();

    await request(
      app,
      "/api/v1/projects/default/eval-ingest/report",
      JSON.stringify({ results: [] })
    );

    expect(meta()).toMatchObject({ origin: "mcpjam", code: "INTERNAL_ERROR" });
    // And a real message, where the row used to carry none at all.
    expect(String((meta() as { message?: string }).message)).toContain("boom");
  });

  it("does NOT claim a connection-class failure, even on this route", async () => {
    // `SERVER_UNREACHABLE` carries positive evidence about an upstream hop, and
    // a boundary declaration must not overrule evidence. Documented gap rather
    // than an oversight: on a route whose only outbound hop IS our own Convex
    // this reads conservatively, and closing it needs a narrower signal than a
    // router-wide declaration — not a louder one.
    global.fetch = vi
      .fn()
      .mockRejectedValue(new TypeError("fetch failed")) as never;
    const { app, meta } = appCapturingMeta();

    await request(
      app,
      "/api/v1/projects/default/eval-ingest/report",
      JSON.stringify({ results: [] })
    );

    expect(meta()).toMatchObject({ code: "SERVER_UNREACHABLE" });
    expect((meta() as { origin?: string }).origin).not.toBe("mcpjam");
  });

  it("does NOT claim a caller's own bad input", async () => {
    // Returned, not thrown, so it never reaches `v1OnError` — this is the path
    // `v1Error`'s own stash covers. It must still never read `mcpjam`.
    const { app, meta } = appCapturingMeta();

    await request(
      app,
      "/api/v1/projects/default/eval-ingest/report",
      "not json at all"
    );

    expect(meta()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect((meta() as { origin?: string }).origin).not.toBe("mcpjam");
  });

  it("stashes meta for a RETURNED timeout, which never reaches v1OnError", async () => {
    global.fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      })
    ) as never;
    const { app, meta } = appCapturingMeta();

    await request(
      app,
      "/api/v1/projects/default/eval-ingest/report",
      JSON.stringify({ results: [] })
    );

    // A 504 that returns directly: before the backstop in `v1Error` this row
    // logged as the bare `internal_error` fallback with no message.
    expect(meta()).toMatchObject({ code: "TIMEOUT", status: 504 });
  });
});
