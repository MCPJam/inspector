import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Covers the v1 chatbox read pass-throughs: bearer + query forwarding to the
// Convex /v1 chatbox routes, verbatim envelope/status passthrough, the
// detail route's projectId cross-check, and upstream-failure mapping.

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

function request(app: Hono, path: string, token = "tok"): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    })
  );
}

const LIST_BODY = {
  items: [
    {
      id: "cbx_1",
      projectId: "p1",
      name: "Support Chatbox",
      mode: "project_members",
      serverCount: 1,
      serverNames: ["server-a"],
    },
  ],
};

const DETAIL_BODY = {
  id: "cbx_1",
  projectId: "p1",
  name: "Support Chatbox",
  modelId: "gpt-4o-mini",
  servers: [{ id: "srv_1", name: "server-a", url: null, useOAuth: false }],
};

describe("v1 chatbox read routes", () => {
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalConvexHttpUrl) {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    } else {
      delete process.env.CONVEX_HTTP_URL;
    }
  });

  it("forwards the list read with the caller's bearer and passes the page through", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(LIST_BODY), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await request(makeApp(), "/api/v1/projects/p1/chatboxes");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(LIST_BODY);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe(
      "https://convex-http.example.com/v1/chatboxes?projectId=p1"
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok"
    );
  });

  it("passes backend error envelopes through with their status", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ code: "VALIDATION_ERROR", message: "bad id" }),
          { status: 400 }
        )
      ) as unknown as typeof fetch;

    const res = await request(makeApp(), "/api/v1/projects/p1/chatboxes");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "VALIDATION_ERROR"
    );
  });

  it("returns the chatbox detail when the path projectId matches", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(DETAIL_BODY), { status: 200 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await request(makeApp(), "/api/v1/projects/p1/chatboxes/cbx_1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DETAIL_BODY);
    expect(String((fetchMock.mock.calls[0] as [URL])[0])).toBe(
      "https://convex-http.example.com/v1/chatbox?chatboxId=cbx_1"
    );
  });

  it("answers NOT_FOUND when the chatbox lives in a different project", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...DETAIL_BODY, projectId: "p2" }), {
        status: 200,
      })
    ) as unknown as typeof fetch;

    const res = await request(makeApp(), "/api/v1/projects/p1/chatboxes/cbx_1");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code?: string }).code).toBe("NOT_FOUND");
  });

  it("maps an unreachable backend onto SERVER_UNREACHABLE", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error("fetch failed")) as unknown as typeof fetch;

    const res = await request(makeApp(), "/api/v1/projects/p1/chatboxes");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "SERVER_UNREACHABLE"
    );
  });

  it("maps a non-JSON backend response (routing 404) onto an internal failure", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("Not Found", { status: 404 })
      ) as unknown as typeof fetch;

    const res = await request(makeApp(), "/api/v1/projects/p1/chatboxes");
    expect(res.status).toBe(500);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "INTERNAL_ERROR"
    );
  });
});
