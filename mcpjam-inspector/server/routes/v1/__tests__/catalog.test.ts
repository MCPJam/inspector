import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Covers the v1 catalog read proxies: path-param -> query-param translation,
// bearer forwarding, verbatim status/body passthrough, and upstream failure
// mapping. The Convex side of the contract is covered by the backend's
// publicApi tests; these assert the Inspector half of the proxy seam.

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

function request(app: Hono, path: string): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "GET",
      headers: { Authorization: "Bearer tok" },
    })
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("v1 catalog read proxies", () => {
  const originalEnv = process.env.CONVEX_HTTP_URL;
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalEnv) process.env.CONVEX_HTTP_URL = originalEnv;
    else delete process.env.CONVEX_HTTP_URL;
  });

  it.each([
    ["/api/v1/me", "https://convex-http.example.com/v1/me"],
    [
      "/api/v1/projects?organizationId=org_1",
      "https://convex-http.example.com/v1/projects?organizationId=org_1",
    ],
    [
      "/api/v1/projects/p1/servers",
      "https://convex-http.example.com/v1/project-servers?projectId=p1",
    ],
    [
      "/api/v1/projects/p1/eval-suites",
      "https://convex-http.example.com/v1/eval-suites?projectId=p1",
    ],
    [
      "/api/v1/chat-sessions?projectId=p1&status=archived&limit=10&before=123",
      "https://convex-http.example.com/v1/chat-sessions?projectId=p1&status=archived&limit=10&before=123",
    ],
  ])("maps %s onto the Convex read surface", async (inspectorPath, convexUrl) => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [] }));
    const res = await request(makeApp(), inspectorPath);
    expect(res.status).toBe(200);
    const [target, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(target)).toBe(convexUrl);
    // JWT callers: the original bearer is forwarded verbatim.
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer tok"
    );
  });

  it("passes the upstream page body through verbatim", async () => {
    const page = {
      items: [{ id: "s_1", name: "echo", transportType: "http" }],
      nextCursor: "cur_2",
    };
    fetchMock.mockResolvedValue(jsonResponse(page));
    const res = await request(makeApp(), "/api/v1/projects/p1/servers");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(page);
  });

  it("passes upstream error envelopes through with their status", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: "NOT_FOUND", message: "Project not found" }, 404)
    );
    const res = await request(makeApp(), "/api/v1/projects/p_bad/servers");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("maps an unreachable upstream to 502 SERVER_UNREACHABLE", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const res = await request(makeApp(), "/api/v1/me");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "SERVER_UNREACHABLE"
    );
  });

  it("maps a non-JSON upstream response to 502", async () => {
    fetchMock.mockResolvedValue(new Response("<html>oops</html>", { status: 200 }));
    const res = await request(makeApp(), "/api/v1/me");
    expect(res.status).toBe(502);
  });

  it("rejects guests at the v1 boundary", async () => {
    validateGuestTokenMock.mockResolvedValue({ valid: true, guestId: "g1" });
    const res = await request(makeApp(), "/api/v1/projects");
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
