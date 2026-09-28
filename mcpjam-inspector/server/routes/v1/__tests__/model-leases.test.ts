import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Covers the v1 model-lease proxy: what it forwards to the broker, the
// `default` project alias, local input validation, and the translation from the
// broker's `{ok: false, error}` shapes to the canonical v1 envelope. Whether a
// lease SHOULD be minted — spend, membership, the model allowlist — is decided
// backend-side and covered by mcpjam-backend's harnessModelBrokerStart tests.

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
  body: unknown,
  token = "tok",
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

function backendResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const MINTED = {
  ok: true,
  runId: "run_lease_1",
  expiresAt: 1_800_000,
  protocol: "anthropic",
  proxyBaseUrl:
    "https://convex-http.example.com/web/harness/model-proxy/anthropic",
  delivery: "sdk-direct",
  lease: "lease.jwt.value",
};

describe("v1 model leases", () => {
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

  it("asks the broker for an sdk-direct lease and returns it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(backendResponse(200, MINTED));
    global.fetch = fetchMock as never;

    const res = await request(
      makeApp(),
      "/api/v1/projects/default/model-leases",
      { model: "anthropic/claude-sonnet-4.5" },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      lease: "lease.jwt.value",
      protocol: "anthropic",
      proxyBaseUrl: MINTED.proxyBaseUrl,
      expiresAt: 1_800_000,
      runId: "run_lease_1",
      model: "anthropic/claude-sonnet-4.5",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://convex-http.example.com/web/harness/model-broker/start",
    );
    expect((init as RequestInit).method).toBe("POST");
    // The `sk_` key is never forwarded — the gateway swaps it for the
    // delegated org-scoped token, same as eval-ingest.
    expect(
      (init as { headers: Record<string, string> }).headers.authorization,
    ).toBe("Bearer tok");
    // The caller names a model; the DELIVERY is ours to declare.
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      delivery: "sdk-direct",
      modelId: "anthropic/claude-sonnet-4.5",
    });
  });

  it("omits projectId for `default` and forwards an explicit id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(backendResponse(200, MINTED));
    global.fetch = fetchMock as never;
    const app = makeApp();

    await request(app, "/api/v1/projects/default/model-leases", {
      model: "anthropic/claude-sonnet-4.5",
    });
    expect(
      JSON.parse(fetchMock.mock.calls[0][1].body).projectId,
    ).toBeUndefined();

    await request(app, "/api/v1/projects/jd7abc/model-leases", {
      model: "anthropic/claude-sonnet-4.5",
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).projectId).toBe(
      "jd7abc",
    );
  });

  it("lets the path segment override a projectId smuggled in the body", async () => {
    // The URL is the single source of truth for which org pays — same rule as
    // eval-ingest, so a lease and the results it produces cannot be aimed at
    // different projects.
    const fetchMock = vi.fn().mockResolvedValue(backendResponse(200, MINTED));
    global.fetch = fetchMock as never;

    await request(makeApp(), "/api/v1/projects/jd7abc/model-leases", {
      model: "anthropic/claude-sonnet-4.5",
      projectId: "someone_elses_project",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).projectId).toBe(
      "jd7abc",
    );
  });

  it("forwards runId and maxOutputTokens when given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(backendResponse(200, MINTED));
    global.fetch = fetchMock as never;

    await request(makeApp(), "/api/v1/projects/default/model-leases", {
      model: "openai/gpt-5-mini",
      runId: "  ci-run-7  ",
      maxOutputTokens: 8192,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      runId: "ci-run-7",
      maxOutputTokens: 8192,
    });
  });

  it.each([
    [{}, "model is required"],
    [{ model: "   " }, "model is required"],
    [{ model: 42 }, "model is required"],
    [{ model: "anthropic/claude-sonnet-4.5", runId: "" }, "runId must be"],
    [
      { model: "anthropic/claude-sonnet-4.5", maxOutputTokens: 0 },
      "maxOutputTokens must be",
    ],
    [
      { model: "anthropic/claude-sonnet-4.5", maxOutputTokens: "lots" },
      "maxOutputTokens must be",
    ],
  ])("rejects %j before calling the backend", async (body, message) => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;

    const res = await request(
      makeApp(),
      "/api/v1/projects/default/model-leases",
      body,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining(message),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a body that is not an object", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;

    for (const raw of ["[]", "null", '"nope"', "{oops"]) {
      const res = await request(
        makeApp(),
        "/api/v1/projects/default/model-leases",
        raw,
      );
      expect(res.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("translates a broker 429 into RATE_LIMITED with Retry-After", async () => {
    // The broker answers `{ok: false, error, retryAfter}`, not a v1 envelope,
    // so the status is mapped rather than passed through. The spec documents
    // `Retry-After` on every 429, so the seconds it reports must reach the
    // wire rather than being dropped.
    global.fetch = vi.fn().mockResolvedValue(
      backendResponse(429, {
        ok: false,
        error: "Spending limit reached; add credits or retry later.",
        retryAfter: 30.2,
      }),
    ) as never;

    const res = await request(
      makeApp(),
      "/api/v1/projects/default/model-leases",
      { model: "anthropic/claude-sonnet-4.5" },
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("31");
    expect(await res.json()).toMatchObject({
      code: "RATE_LIMITED",
      message: "Spending limit reached; add credits or retry later.",
    });
  });

  it.each([
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [500, "SERVER_UNREACHABLE"],
    [502, "SERVER_UNREACHABLE"],
  ])("maps a broker %i to %s", async (status, code) => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        backendResponse(status, { ok: false, error: "nope" }),
      ) as never;

    const res = await request(
      makeApp(),
      "/api/v1/projects/default/model-leases",
      { model: "anthropic/claude-sonnet-4.5" },
    );
    expect(await res.json()).toMatchObject({ code, message: "nope" });
  });

  it("treats a 200 that is not ok as a failure", async () => {
    // Fail closed on a shape we do not recognize: returning `lease: undefined`
    // with a 200 would make the SDK call the proxy with no credential and
    // report a confusing 401 instead of what actually went wrong.
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        backendResponse(200, { ok: false, error: "weird" }),
      ) as never;

    const res = await request(
      makeApp(),
      "/api/v1/projects/default/model-leases",
      { model: "anthropic/claude-sonnet-4.5" },
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ message: "weird" });
  });

  it("revokes by runId", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        backendResponse(200, { ok: true, revoked: 2, networkCleared: true }),
      );
    global.fetch = fetchMock as never;

    const res = await request(
      makeApp(),
      "/api/v1/projects/default/model-leases/revoke",
      { runId: "run_lease_1" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revoked: 2 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://convex-http.example.com/web/harness/model-broker/revoke",
    );
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      delivery: "sdk-direct",
      runId: "run_lease_1",
    });
  });

  it("scopes revocation to the path project and SDK delivery", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(backendResponse(200, { ok: true, revoked: 1 }));
    global.fetch = fetchMock as never;
    await request(makeApp(), "/api/v1/projects/project_a/model-leases/revoke", {
      runId: "shared_run",
      projectId: "project_b",
      delivery: "e2b-network-transform",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      runId: "shared_run",
      projectId: "project_a",
      delivery: "sdk-direct",
    });
  });

  it("requires a runId to revoke", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;

    const res = await request(
      makeApp(),
      "/api/v1/projects/default/model-leases/revoke",
      {},
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers TIMEOUT when the broker stalls", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      ) as never;

    const res = await request(
      makeApp(),
      "/api/v1/projects/default/model-leases",
      { model: "anthropic/claude-sonnet-4.5" },
    );
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ code: "TIMEOUT" });
  });

  it("is closed to guests — every lease can spend credits", async () => {
    validateGuestTokenMock.mockResolvedValue({
      valid: true,
      guestId: "guest_1",
    });
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;

    const res = await request(
      makeApp(),
      "/api/v1/projects/default/model-leases",
      { model: "anthropic/claude-sonnet-4.5" },
      "guest_token",
    );
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
