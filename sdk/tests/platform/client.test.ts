import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PLATFORM_API_BASE_URL,
  PlatformApiClient,
  PlatformApiError,
} from "../../src/platform/index.js";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function makeClient(
  fetchMock: FetchMock,
  options: Partial<ConstructorParameters<typeof PlatformApiClient>[0]> = {}
): PlatformApiClient {
  return new PlatformApiClient({
    baseUrl: "https://api.example.com/api/v1",
    getAuth: () => "sk_test_token",
    fetch: fetchMock as unknown as typeof fetch,
    ...options,
  });
}

function requestOf(fetchMock: FetchMock, call = 0): { url: URL; init: RequestInit } {
  const [target, init] = fetchMock.mock.calls[call]!;
  return { url: new URL(String(target)), init: init as RequestInit };
}

describe("PlatformApiClient", () => {
  it("defaults to the hosted production base URL", () => {
    expect(DEFAULT_PLATFORM_API_BASE_URL).toBe("https://app.mcpjam.com/api/v1");
  });

  it("sends GET requests with bearer auth and skips undefined query params", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }));
    const client = makeClient(fetchMock);

    await client.listProjects({ organizationId: undefined });
    await client.listProjects({ organizationId: "org-1" });

    const first = requestOf(fetchMock, 0);
    expect(first.url.href).toBe("https://api.example.com/api/v1/projects");
    expect(first.init.method).toBe("GET");
    expect(first.init.body).toBeUndefined();
    expect(
      new Headers(first.init.headers as HeadersInit).get("authorization")
    ).toBe("Bearer sk_test_token");

    const second = requestOf(fetchMock, 1);
    expect(second.url.searchParams.get("organizationId")).toBe("org-1");
  });

  it("resolves auth lazily per request", async () => {
    const tokens = ["token-a", "token-b"];
    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }));
    const client = makeClient(fetchMock, {
      getAuth: async () => tokens.shift()!,
    });

    await client.getMe();
    await client.getMe();

    expect(
      new Headers(requestOf(fetchMock, 0).init.headers as HeadersInit).get(
        "authorization"
      )
    ).toBe("Bearer token-a");
    expect(
      new Headers(requestOf(fetchMock, 1).init.headers as HeadersInit).get(
        "authorization"
      )
    ).toBe("Bearer token-b");
  });

  it("encodes path params and posts a default empty JSON body for server ops", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: "ready" }));
    const client = makeClient(fetchMock);

    await client.doctorServer({ projectId: "p/1", serverId: "s 2" });

    const { url, init } = requestOf(fetchMock);
    expect(url.pathname).toBe("/api/v1/projects/p%2F1/servers/s%202/doctor");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect(
      new Headers(init.headers as HeadersInit).get("content-type")
    ).toBe("application/json");
  });

  it("forwards explicit server-op bodies and chat-session filters", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }));
    const client = makeClient(fetchMock);

    await client.listServerTools({
      projectId: "p1",
      serverId: "s1",
      body: { cursor: "abc" },
    });
    await client.listChatSessions({ projectId: "p1", limit: 5 });

    expect(requestOf(fetchMock, 0).init.body).toBe(JSON.stringify({ cursor: "abc" }));
    const sessions = requestOf(fetchMock, 1).url;
    expect(sessions.pathname).toBe("/api/v1/chat-sessions");
    expect(sessions.searchParams.get("projectId")).toBe("p1");
    expect(sessions.searchParams.get("limit")).toBe("5");
  });

  it("posts tunnel creates with the name body and encoded project id", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ serverId: "srv_1", slug: "calm-otter" })
    );
    const client = makeClient(fetchMock);

    await client.createTunnel({ projectId: "p/1", name: "my server" });

    const { url, init } = requestOf(fetchMock);
    expect(url.pathname).toBe("/api/v1/projects/p%2F1/tunnels");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "my server" }));
  });

  it("posts tunnel closes with encoded path params and no body", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ serverId: "s 2", status: "closed" })
    );
    const client = makeClient(fetchMock);

    const result = await client.closeTunnel({
      projectId: "p/1",
      serverId: "s 2",
    });

    const { url, init } = requestOf(fetchMock);
    expect(url.pathname).toBe("/api/v1/projects/p%2F1/tunnels/s%202/close");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(result.status).toBe("closed");
  });

  it("builds chatbox read URLs with encoded path params", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }));
    const client = makeClient(fetchMock);

    await client.listChatboxes({ projectId: "p1" });
    await client.getChatbox({ projectId: "p1", chatboxId: "box/1" });

    expect(requestOf(fetchMock, 0).url.pathname).toBe(
      "/api/v1/projects/p1/chatboxes"
    );
    const detail = requestOf(fetchMock, 1);
    expect(detail.url.pathname).toBe("/api/v1/projects/p1/chatboxes/box%2F1");
    expect(detail.init.method).toBe("GET");
  });

  it("posts eval-run creation bodies and parses the 202 envelope", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          runId: "run-1",
          suiteId: "suite-1",
          status: "running",
          caseUpsert: { committed: [], failed: [] },
        },
        { status: 202 }
      )
    );
    const client = makeClient(fetchMock);

    const created = await client.createEvalRun({
      projectId: "p1",
      body: { suiteId: "suite-1", serverIds: ["s1", "s2"] },
    });

    const { url, init } = requestOf(fetchMock);
    expect(url.pathname).toBe("/api/v1/projects/p1/eval-runs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      suiteId: "suite-1",
      serverIds: ["s1", "s2"],
    });
    expect(created.runId).toBe("run-1");
    expect(created.status).toBe("running");
  });

  it("posts eval-suite creation bodies and parses the 201 envelope", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          suiteId: "suite-9",
          name: "Authored",
          servers: [{ id: "s1" }],
          caseUpsert: { committed: [{ name: "c1" }], failed: [] },
        },
        { status: 201 }
      )
    );
    const client = makeClient(fetchMock);

    const created = await client.createEvalSuite({
      projectId: "p1",
      body: {
        name: "Authored",
        serverIds: ["s1"],
        model: "anthropic/claude-haiku-4.5",
        tests: [{ title: "t", query: "q" }],
      },
    });

    const { url, init } = requestOf(fetchMock);
    expect(url.pathname).toBe("/api/v1/projects/p1/eval-suites");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Authored",
      serverIds: ["s1"],
      model: "anthropic/claude-haiku-4.5",
      tests: [{ title: "t", query: "q" }],
    });
    expect(created.suiteId).toBe("suite-9");
    expect(created.name).toBe("Authored");
  });

  it("builds eval polling URLs and forwards cursor/limit query params", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }));
    const client = makeClient(fetchMock);

    await client.getEvalRun({ projectId: "p1", runId: "run-1" });
    await client.listEvalRunIterations({
      projectId: "p1",
      runId: "run-1",
      cursor: "abc",
      limit: 25,
    });
    await client.getEvalIterationTrace({
      projectId: "p1",
      runId: "run-1",
      iterationId: "iter-1",
    });
    await client.listEvalSuiteRuns({
      projectId: "p1",
      suiteId: "suite-1",
      limit: 10,
    });

    expect(requestOf(fetchMock, 0).url.pathname).toBe(
      "/api/v1/projects/p1/eval-runs/run-1"
    );
    const iterations = requestOf(fetchMock, 1).url;
    expect(iterations.pathname).toBe(
      "/api/v1/projects/p1/eval-runs/run-1/iterations"
    );
    expect(iterations.searchParams.get("cursor")).toBe("abc");
    expect(iterations.searchParams.get("limit")).toBe("25");
    expect(requestOf(fetchMock, 2).url.pathname).toBe(
      "/api/v1/projects/p1/eval-runs/run-1/iterations/iter-1/trace"
    );
    const suiteRuns = requestOf(fetchMock, 3).url;
    expect(suiteRuns.pathname).toBe(
      "/api/v1/projects/p1/eval-suites/suite-1/runs"
    );
    expect(suiteRuns.searchParams.get("limit")).toBe("10");
  });

  it("sets a user-agent header only when configured", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    await makeClient(fetchMock).getMe();
    await makeClient(fetchMock, { userAgent: "mcpjam-cli/1.0" }).getMe();

    expect(
      new Headers(requestOf(fetchMock, 0).init.headers as HeadersInit).get(
        "user-agent"
      )
    ).toBeNull();
    expect(
      new Headers(requestOf(fetchMock, 1).init.headers as HeadersInit).get(
        "user-agent"
      )
    ).toBe("mcpjam-cli/1.0");
  });

  it("maps wire error envelopes onto PlatformApiError", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          code: "OAUTH_REQUIRED",
          message: "Server requires OAuth",
          details: { oauthRequired: true, serverId: "s1" },
        },
        { status: 401 }
      )
    );

    const error = await makeClient(fetchMock)
      .doctorServer({ projectId: "p1", serverId: "s1" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    const apiError = error as PlatformApiError;
    expect(apiError.code).toBe("OAUTH_REQUIRED");
    expect(apiError.status).toBe(401);
    expect(apiError.message).toBe("Server requires OAuth");
    expect(apiError.details).toEqual({ oauthRequired: true, serverId: "s1" });
    expect(apiError.endpoint).toBe("/projects/p1/servers/s1/doctor");
  });

  it("captures Retry-After on 429 responses", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { code: "RATE_LIMITED", message: "Slow down" },
        { status: 429, headers: { "retry-after": "7" } }
      )
    );

    const error = await makeClient(fetchMock)
      .getMe()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).code).toBe("RATE_LIMITED");
    expect((error as PlatformApiError).retryAfter).toBe(7);
  });

  it("parses HTTP-date Retry-After values into seconds", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { code: "RATE_LIMITED", message: "Slow down" },
        {
          status: 429,
          headers: { "retry-after": new Date(Date.now() + 30_000).toUTCString() },
        }
      )
    );

    const error = await makeClient(fetchMock)
      .getMe()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    const retryAfter = (error as PlatformApiError).retryAfter;
    expect(retryAfter).toBeGreaterThanOrEqual(28);
    expect(retryAfter).toBeLessThanOrEqual(31);
  });

  it("falls back to INTERNAL_ERROR for malformed error envelopes", async () => {
    const fetchMock = vi.fn(
      async () => new Response("upstream exploded", { status: 502 })
    );

    const error = await makeClient(fetchMock)
      .getMe()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).code).toBe("INTERNAL_ERROR");
    expect((error as PlatformApiError).status).toBe(502);
  });

  it("resolves empty success bodies to undefined", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

    await expect(makeClient(fetchMock).getMe()).resolves.toBeUndefined();
  });

  it("keeps non-JSON success bodies as INTERNAL_ERROR", async () => {
    const fetchMock = vi.fn(
      async () => new Response("<html>not json</html>", { status: 200 })
    );

    const error = await makeClient(fetchMock)
      .getMe()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).code).toBe("INTERNAL_ERROR");
    expect((error as PlatformApiError).status).toBe(200);
  });

  it("derives status-based codes for envelope-less error bodies", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, { status: 429, headers: { "retry-after": "12" } })
    );

    const error = await makeClient(fetchMock)
      .getMe()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).code).toBe("RATE_LIMITED");
    expect((error as PlatformApiError).status).toBe(429);
    expect((error as PlatformApiError).retryAfter).toBe(12);
  });

  it("derives UNAUTHORIZED from a bare 401 with a non-JSON body", async () => {
    const fetchMock = vi.fn(
      async () => new Response("Unauthorized", { status: 401 })
    );

    const error = await makeClient(fetchMock)
      .getMe()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).code).toBe("UNAUTHORIZED");
    expect((error as PlatformApiError).message).toBe(
      "Request to /me failed (401)"
    );
  });

  it("synthesizes NETWORK_ERROR for fetch-level failures", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });

    const error = await makeClient(fetchMock)
      .getMe()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).code).toBe("NETWORK_ERROR");
    expect((error as PlatformApiError).status).toBe(0);
    expect((error as PlatformApiError).message).toContain("ENOTFOUND");
  });

  it("synthesizes TIMEOUT when the client-side deadline aborts the request", async () => {
    const fetchMock = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        })
    );

    const error = await makeClient(fetchMock, { timeoutMs: 10 })
      .getMe()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).code).toBe("TIMEOUT");
    expect((error as PlatformApiError).status).toBe(0);
  });

  it("propagates caller-initiated aborts untouched", async () => {
    const fetchMock = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const fail = () =>
            reject(new DOMException("caller aborted", "AbortError"));
          if (init?.signal?.aborted) {
            fail();
            return;
          }
          init?.signal?.addEventListener("abort", fail);
        })
    );
    const controller = new AbortController();
    const pending = makeClient(fetchMock)
      .getMe({ signal: controller.signal })
      .catch((caught: unknown) => caught);
    controller.abort();

    const error = await pending;
    expect(error).not.toBeInstanceOf(PlatformApiError);
    expect((error as DOMException).name).toBe("AbortError");
  });
});
