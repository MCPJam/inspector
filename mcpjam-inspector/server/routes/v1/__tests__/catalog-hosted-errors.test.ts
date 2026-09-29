/**
 * MJ-020 (retest #3 residual): the read-proxy family must not relay Convex's
 * own exception text. An upstream error envelope carrying an
 * `ArgumentValidationError` — which quotes the whole validator definition —
 * answers with generic copy and a request id in hosted mode, with the detail
 * logged. Envelopes the upstream authored keep passing through verbatim
 * (covered here and in `catalog.test.ts`), as does everything in local mode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const config = vi.hoisted(() => ({ hosted: true }));

vi.mock("../../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config.js")>();
  return {
    ...actual,
    get HOSTED_MODE() {
      return config.hosted;
    },
  };
});

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: vi.fn().mockResolvedValue({ valid: false }),
}));

vi.mock("../../../utils/analytics.js", () => ({
  captureServerEvent: vi.fn(),
}));

import v1Routes from "../index.js";
import { logger } from "../../../utils/logger.js";

const CONVEX_DETAIL =
  "[Request ID: req_abc123] Server Error\n" +
  "ArgumentValidationError: Value does not match validator.\n" +
  "Path: .sourceType\n" +
  'Value: "mcp-widgets"\n' +
  'Validator: v.union(v.literal("mcp-apps"), v.literal("openai-apps"))';

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function request(app: Hono, path: string): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "GET",
      headers: { Authorization: "Bearer tok" },
    }),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("v1 read proxies, hosted Convex exception relays", () => {
  const originalEnv = process.env.CONVEX_HTTP_URL;
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    config.hosted = true;
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    if (originalEnv) process.env.CONVEX_HTTP_URL = originalEnv;
    else delete process.env.CONVEX_HTTP_URL;
  });

  it("withholds a relayed validator from a 400, keeping the status", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: "VALIDATION_ERROR", message: CONVEX_DETAIL }, 400),
    );
    const res = await request(
      makeApp(),
      "/api/v1/projects/p1/sessions?sourceType=mcp-widgets",
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      code?: string;
      message?: string;
      details?: { requestId?: string };
    };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.message).toContain("request parameters were invalid");
    expect(typeof body.details?.requestId).toBe("string");
    expect(body.message).toContain(body.details!.requestId!);
    const everything = JSON.stringify(body);
    expect(everything).not.toContain("ArgumentValidationError");
    expect(everything).not.toContain("Validator:");
    expect(everything).not.toContain("v.union");
    expect(everything).not.toContain("v.literal");
    expect(everything).not.toContain("req_abc123");
  });

  it("withholds a relayed validator from a 500 with the internal-error copy", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: "INTERNAL_ERROR", message: CONVEX_DETAIL }, 500),
    );
    const res = await request(makeApp(), "/api/v1/projects/p1/servers");

    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      code?: string;
      message?: string;
      details?: { requestId?: string };
    };
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.message).toContain("An unexpected error occurred");
    expect(body.message).toContain(body.details!.requestId!);
    expect(JSON.stringify(body)).not.toContain("ArgumentValidationError");
  });

  it("logs the withheld text under the request id it answered with", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: "VALIDATION_ERROR", message: CONVEX_DETAIL }, 400),
    );
    const res = await request(makeApp(), "/api/v1/projects/p1/servers");

    const body = (await res.json()) as { details?: { requestId?: string } };
    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(logged).toContain("ArgumentValidationError");
    expect(logged).toContain(body.details!.requestId!);
  });

  it("keeps passing upstream-authored error envelopes through verbatim", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: "NOT_FOUND", message: "Project not found" }, 404),
    );
    const res = await request(makeApp(), "/api/v1/projects/p_bad/servers");

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      code: "NOT_FOUND",
      message: "Project not found",
    });
  });

  it("keeps the relayed text when not hosted", async () => {
    config.hosted = false;
    fetchMock.mockResolvedValue(
      jsonResponse({ code: "VALIDATION_ERROR", message: CONVEX_DETAIL }, 400),
    );
    const res = await request(makeApp(), "/api/v1/projects/p1/servers");

    expect(res.status).toBe(400);
    expect(((await res.json()) as { message?: string }).message).toBe(
      CONVEX_DETAIL,
    );
  });
});
