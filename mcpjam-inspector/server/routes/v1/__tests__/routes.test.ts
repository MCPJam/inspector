import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Drives the mounted /api/v1 live-op routes end-to-end with the Convex
// authorize call and the SDK doctor stubbed, mirroring the existing
// web/servers-doctor harness. Validates body synthesis (path params ->
// web schema), the shared connection/authorize path, and the v1 envelope.

const { runServerDoctorMock } = vi.hoisted(() => ({
  runServerDoctorMock: vi.fn(),
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

import v1Routes from "../index.js";

function makeApp(): Hono {
  const app = new Hono();
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
});
