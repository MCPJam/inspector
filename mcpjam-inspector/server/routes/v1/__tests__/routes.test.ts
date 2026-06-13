import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Drives the mounted /api/v1 live-op routes end-to-end with the Convex
// authorize call and the SDK doctor stubbed, mirroring the existing
// web/servers-doctor harness. Validates body synthesis (path params ->
// web schema), the shared connection/authorize path, and the v1 envelope.

const { runServerDoctorMock, validateGuestTokenMock } = vi.hoisted(() => ({
  runServerDoctorMock: vi.fn(),
  validateGuestTokenMock: vi.fn(),
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  return {
    ...actual,
    runServerDoctor: runServerDoctorMock,
    isMCPAuthError: vi.fn().mockReturnValue(false),
  };
});

// bearerAuthMiddleware calls validateGuestTokenDetailedAsync on every request
// to detect guest JWTs. Stub it so the suite can drive the guest-vs-WorkOS
// branch deterministically without spinning up the real guest-token service.
vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

import v1Routes from "../index.js";
import { sessionAuthMiddleware } from "../../../middleware/session-auth.js";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

// Mirrors the production wiring: the global session-auth middleware runs before
// /api/v1 is mounted. /api/v1 must be bypassed (it does its own bearer auth), or
// `Authorization: Bearer` callers 401 before ever reaching the v1 router.
function makeFullStackApp(): Hono {
  const app = new Hono();
  app.use("*", sessionAuthMiddleware);
  app.route("/api/v1", v1Routes);
  return app;
}

function post(
  app: Hono,
  path: string,
  body: Record<string, unknown>,
  token?: string
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
  );
}

describe("v1 live-op routes", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://convex.example.com";
    // Default: bearer tokens in these tests aren't guest JWTs. Tests that
    // exercise the guest-rejection guard override this to return a valid guest.
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    runServerDoctorMock.mockResolvedValue({
      status: "ready",
      target: { kind: "http", scope: "hosted", label: "Server" },
      checks: {},
      connection: { status: "connected", detail: "ok" },
      probe: null,
      initInfo: null,
      capabilities: null,
      tools: [],
      toolsMetadata: {},
      resources: [],
      resourceTemplates: [],
      prompts: [],
      error: null,
      generatedAt: "2026-06-08T00:00:00.000Z",
    });
    global.fetch = vi.fn(async (input: any) => {
      if (String(input).endsWith("/web/authorize")) {
        return new Response(
          JSON.stringify({
            authorized: true,
            role: "member",
            accessLevel: "project_member",
            permissions: { chatOnly: false },
            serverConfig: {
              transportType: "http",
              url: "https://server.example.com/mcp",
              useOAuth: true,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalConvexHttpUrl) {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    } else {
      delete process.env.CONVEX_HTTP_URL;
    }
  });

  it("rejects a request with no bearer token (401, canonical v1 envelope)", async () => {
    const res = await post(
      makeApp(),
      "/api/v1/projects/p1/servers/s1/doctor",
      {}
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      code: "UNAUTHORIZED",
      message: expect.any(String),
    });
  });

  it("runs the doctor workflow and returns the result as a v1 resource", async () => {
    const res = await post(
      makeApp(),
      "/api/v1/projects/p1/servers/s1/doctor",
      { serverName: "Example" },
      "tok"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ready");
    expect(body).not.toHaveProperty("code");
    expect(runServerDoctorMock).toHaveBeenCalledTimes(1);
  });

  it("check-oauth returns the authorize projection directly", async () => {
    const res = await post(
      makeApp(),
      "/api/v1/projects/p1/servers/s1/check-oauth",
      {},
      "tok"
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      useOAuth: true,
      serverUrl: "https://server.example.com/mcp",
    });
  });

  it("maps a missing required field to a 400 VALIDATION_ERROR envelope", async () => {
    // resources/read requires `uri`; omitting it trips the web Zod schema,
    // which the v1 onError maps onto the public VALIDATION_ERROR code.
    const res = await post(
      makeApp(),
      "/api/v1/projects/p1/servers/s1/resources/read",
      {},
      "tok"
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("admits a guest on an allowlisted platform-tool route (doctor)", async () => {
    // doctor is part of the platform MCP tool surface, so guests are admitted
    // and the live-MCP path runs (the deeper Convex authorize call enforces
    // the guest's own project access).
    validateGuestTokenMock.mockResolvedValue({
      valid: true,
      guestId: "guest_abc",
    });
    const res = await post(
      makeApp(),
      "/api/v1/projects/p1/servers/s1/doctor",
      { serverName: "Example" },
      "guest_bearer"
    );
    expect(res.status).toBe(200);
    expect(runServerDoctorMock).toHaveBeenCalled();
  });

  it("rejects a guest on a non-allowlisted route (export) with 401 UNAUTHORIZED", async () => {
    // export is NOT part of the platform MCP tool allowlist, so the perimeter
    // guard rejects guests before the handler runs. Default-deny: only the
    // enumerated platform-tool routes admit guests.
    validateGuestTokenMock.mockResolvedValue({
      valid: true,
      guestId: "guest_abc",
    });
    const res = await post(
      makeApp(),
      "/api/v1/projects/p1/servers/s1/export",
      { serverName: "Example" },
      "guest_bearer"
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      code: "UNAUTHORIZED",
      message: expect.stringMatching(/guest/i),
    });
    expect(runServerDoctorMock).not.toHaveBeenCalled();
  });

  it("reaches v1 through sessionAuthMiddleware with only Authorization: Bearer", async () => {
    // No X-MCP-Session-Auth header. Without the /api/v1 bypass in
    // sessionAuthMiddleware this 401s with "Session token required" before the
    // v1 router runs; with the bypass it flows through to the doctor handler.
    const res = await post(
      makeFullStackApp(),
      "/api/v1/projects/p1/servers/s1/doctor",
      { serverName: "Example" },
      "tok"
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status?: string }).status).toBe("ready");
  });
});
