import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebTestApp, expectJson } from "./helpers/test-app.js";

// The api-keys routes forward the caller's bearer to the backend's
// `/web/api-keys` route, which does all auth/validation. These tests stub the
// backend `fetch` and assert the forwarding + response-shape mapping; they no
// longer touch WorkOS.

const BACKEND = "https://backend.test";
const KEYS_URL = `${BACKEND}/web/api-keys`;

function backendJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stub global fetch to answer the backend `/web/api-keys` route. */
function stubBackend(responder: (url: URL, init: RequestInit) => Response) {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/web/api-keys") {
      return responder(url, init ?? {});
    }
    return backendJson({ ok: false, error: "unexpected call" }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const { app } = createWebTestApp();

function authed(path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      Authorization: "Bearer session-jwt",
      ...(init.headers ?? {}),
    },
  });
}

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", BACKEND);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("web routes — API keys (backend forwarding)", () => {
  it("forwards the caller's bearer verbatim and maps the create response", async () => {
    const created = {
      ok: true,
      key: {
        id: "key_1",
        name: "ci",
        obfuscatedValue: "sk_...abcd",
        createdAt: 1_730_000_000_000,
        value: "sk_mcpjam_" + "a".repeat(48),
      },
    };
    const fetchMock = stubBackend(() => backendJson(created));

    const { status, data } = await expectJson<any>(
      await authed("/api/web/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "ci", organizationId: "org_1" }),
      }),
    );

    expect(status).toBe(200);
    // Exact CreatedApiKey snake_case shape.
    expect(data).toEqual({
      id: "key_1",
      name: "ci",
      obfuscated_value: "sk_...abcd",
      created_at: new Date(1_730_000_000_000).toISOString(),
      last_used_at: null,
      value: "sk_mcpjam_" + "a".repeat(48),
    });

    const [target, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(target).toBe(KEYS_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer session-jwt",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      name: "ci",
      organizationId: "org_1",
    });
  });

  it("maps the list response to { items: [...] } snake_case", async () => {
    stubBackend(() =>
      backendJson({
        ok: true,
        keys: [
          {
            id: "key_1",
            name: "ci",
            obfuscatedValue: "sk_...abcd",
            createdAt: 1_730_000_000_000,
            lastUsedAt: 1_730_000_500_000,
          },
          {
            id: "key_2",
            name: "local",
            obfuscatedValue: "sk_...efgh",
            createdAt: 1_730_000_100_000,
            lastUsedAt: null,
          },
        ],
      }),
    );

    const { status, data } = await expectJson<any>(
      await authed("/api/web/api-keys", { method: "GET" }),
    );

    expect(status).toBe(200);
    expect(data).toEqual({
      items: [
        {
          id: "key_1",
          name: "ci",
          obfuscated_value: "sk_...abcd",
          created_at: new Date(1_730_000_000_000).toISOString(),
          last_used_at: new Date(1_730_000_500_000).toISOString(),
        },
        {
          id: "key_2",
          name: "local",
          obfuscated_value: "sk_...efgh",
          created_at: new Date(1_730_000_100_000).toISOString(),
          last_used_at: null,
        },
      ],
    });
  });

  it("forwards the key id on revoke and returns { ok: true }", async () => {
    const fetchMock = stubBackend(() => backendJson({ ok: true }));

    const { status, data } = await expectJson<any>(
      await authed("/api/web/api-keys/key_del_1", { method: "DELETE" }),
    );

    expect(status).toBe(200);
    expect(data).toEqual({ ok: true });
    const [target, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(target).toBe(`${KEYS_URL}?keyId=key_del_1`);
    expect(init.method).toBe("DELETE");
  });

  it("maps a backend 404 on revoke to 404 NOT_FOUND", async () => {
    stubBackend(() => backendJson({ ok: false, error: "Key not found" }, 404));

    const { status, data } = await expectJson<any>(
      await authed("/api/web/api-keys/key_missing", { method: "DELETE" }),
    );

    expect(status).toBe(404);
    expect(data).toMatchObject({ code: "NOT_FOUND", message: "API key not found" });
  });

  it("passes a backend 403 through as 403 FORBIDDEN", async () => {
    stubBackend(() =>
      backendJson(
        { ok: false, error: "Minting user is not a member of the target organization" },
        403,
      ),
    );

    const { status, data } = await expectJson<any>(
      await authed("/api/web/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "ci", organizationId: "org_x" }),
      }),
    );

    expect(status).toBe(403);
    expect(data).toMatchObject({ code: "FORBIDDEN" });
  });

  it("maps an unreachable backend to 502 SERVER_UNREACHABLE", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );

    const { status, data } = await expectJson<any>(
      await authed("/api/web/api-keys", { method: "GET" }),
    );

    expect(status).toBe(502);
    expect(data).toMatchObject({ code: "SERVER_UNREACHABLE" });
  });

  it("rejects an sk_ bearer with 403 before any backend call", async () => {
    const fetchMock = stubBackend(() => backendJson({ ok: true }));

    const { status, data } = await expectJson<any>(
      await app.request("/api/web/api-keys", {
        method: "GET",
        headers: { Authorization: "Bearer sk_mcpjam_" + "a".repeat(48) },
      }),
    );

    expect(status).toBe(403);
    expect(data).toMatchObject({ code: "FORBIDDEN" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
