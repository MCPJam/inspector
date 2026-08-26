import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

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

describe("v1 conformance-ingest proxies", () => {
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
        runId: "run_1",
        runUrl: "https://app.mcpjam.com/conformance/runs/run_1",
      })
    );
    global.fetch = fetchMock as never;

    const res = await request(
      makeApp(),
      "/api/v1/projects/default/conformance-ingest/report",
      JSON.stringify({
        requestedSuites: ["protocol"],
        reports: [{ suiteKind: "protocol", report: { passed: true } }],
      })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, runId: "run_1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://convex-http.example.com/v1/conformance/ingest/report"
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
      "/api/v1/projects/default/conformance-ingest/runs/start",
      JSON.stringify({
        requestedSuites: ["protocol"],
        projectId: "smuggled",
      })
    );
    const defaultPayload = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body)
    );
    expect(defaultPayload).not.toHaveProperty("projectId");

    await request(
      makeApp(),
      "/api/v1/projects/jd7abc/conformance-ingest/runs/start",
      JSON.stringify({
        requestedSuites: ["protocol"],
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
      backendResponse(409, {
        code: "CONFORMANCE_REPORT_HASH_CONFLICT",
        message: "Suite protocol was already uploaded with a different report",
      })
    ) as never;

    const res = await request(
      makeApp(),
      "/api/v1/projects/jd7other/conformance-ingest/runs/reports",
      JSON.stringify({
        runId: "run_1",
        suiteKind: "protocol",
        report: { passed: true },
      })
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "CONFORMANCE_REPORT_HASH_CONFLICT",
    });
  });

  it("rejects malformed JSON locally with a v1 VALIDATION_ERROR", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;

    const res = await request(
      makeApp(),
      "/api/v1/projects/default/conformance-ingest/runs/finalize",
      "{not json"
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
