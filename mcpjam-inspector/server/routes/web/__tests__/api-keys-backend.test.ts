import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebTestApp, expectJson } from "./helpers/test-app.js";
import {
  createWorkosKeyBinding,
  lookupWorkosKeyBinding,
} from "../../../services/workos-key-bindings.js";
import { setRevokedSessionCacheForTests } from "../../../services/revoked-session-cache.js";

/**
 * Mint, list and revoke of the caller's own keys forwarded to the backend's
 * `/web/api-keys` routes, which hold the WorkOS key. The in-Inspector path
 * these replace is covered in `api-keys.test.ts`; here it must only run when
 * the switch is off or the backend lacks the routes.
 */

vi.mock("../../../services/authkit-jwt.js", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    verifyAuthKitToken: vi
      .fn()
      .mockResolvedValue({ sub: "user_session_1", orgId: undefined }),
  };
});

vi.mock("../../../services/workos-key-bindings.js", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    lookupWorkosKeyBinding: vi.fn().mockResolvedValue(null),
    createWorkosKeyBinding: vi.fn().mockResolvedValue(undefined),
    removeWorkosKeyBinding: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../../services/identity.js", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    resolveUserByExternalId: vi
      .fn()
      .mockResolvedValue({ _id: "mcpjam_user_1" }),
  };
});

const BACKEND = "https://backend.test";
const SESSION = "Bearer session-jwt";

type Call = {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
};

/**
 * Answers backend requests with `backend` and WorkOS requests with an empty
 * key list, recording every request in order.
 */
function stubNetwork(backend: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.startsWith(BACKEND)) return backend();
      return Response.json({ data: [], list_metadata: { after: null } });
    }),
  );
  return calls;
}

const backendCalls = (calls: Call[]) =>
  calls.filter((call) => call.url.startsWith(BACKEND));
const workosCalls = (calls: Call[]) =>
  calls.filter((call) => call.url.startsWith("https://api.workos.com"));

function request(
  app: ReturnType<typeof createWebTestApp>["app"],
  method: "GET" | "POST" | "DELETE",
  path = "/api/web/api-keys",
  body?: unknown,
  authorization = SESSION,
) {
  return app.request(path, {
    method,
    headers: {
      Authorization: authorization,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("API keys through the backend", () => {
  const { app } = createWebTestApp();

  beforeEach(() => {
    setRevokedSessionCacheForTests(null);
    vi.stubEnv("MCPJAM_API_KEYS_VIA_BACKEND", "true");
    vi.stubEnv("CONVEX_HTTP_URL", BACKEND);
    vi.stubEnv("WORKOS_API_KEY", "sk_test_admin");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "test-service-token");
    vi.mocked(createWorkosKeyBinding).mockClear();
    vi.mocked(lookupWorkosKeyBinding).mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    setRevokedSessionCacheForTests(undefined);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("mints with the caller's own bearer and answers with the backend's body", async () => {
    const created = {
      object: "api_key",
      id: "api_key_1",
      name: "CI key",
      value: "sk_test_created_once",
      expires_at: "2027-01-01T00:00:00.000Z",
    };
    const calls = stubNetwork(() => Response.json(created));

    const { status, data } = await expectJson(
      await request(app, "POST", undefined, {
        name: "CI key",
        organizationId: "org_convex_1",
        expiresInDays: 30,
      }),
    );

    expect(status).toBe(200);
    expect(data).toEqual(created);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe(`${BACKEND}/web/api-keys`);
    expect(call.method).toBe("POST");
    expect(call.headers.get("authorization")).toBe(SESSION);
    // The backend takes the user from the bearer; the Inspector names no one.
    expect(call.headers.get("x-inspector-service-token")).toBeNull();
    expect(call.headers.get("x-mcpjam-acting-as")).toBeNull();
    expect(call.body).toEqual({
      name: "CI key",
      organizationId: "org_convex_1",
      expiresInDays: 30,
    });
    expect(createWorkosKeyBinding).not.toHaveBeenCalled();
  });

  it("lists and revokes the caller's keys through the backend", async () => {
    const items = [{ id: "api_key_1", name: "a", organizationId: null }];
    const listCalls = stubNetwork(() => Response.json({ items }));
    const listed = await expectJson(await request(app, "GET"));
    expect(listed).toEqual({ status: 200, data: { items } });
    expect(listCalls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${BACKEND}/web/api-keys`,
    ]);

    const revokeCalls = stubNetwork(() => Response.json({ ok: true }));
    const revoked = await expectJson(
      await request(app, "DELETE", "/api/web/api-keys/api_key%2F1"),
    );
    expect(revoked).toEqual({ status: 200, data: { ok: true } });
    expect(revokeCalls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `DELETE ${BACKEND}/web/api-keys?keyId=api_key%2F1`,
    ]);
    expect(revokeCalls[0].headers.get("authorization")).toBe(SESSION);
  });

  it("passes the backend's refusals through with their status, code and details", async () => {
    stubNetwork(() =>
      Response.json(
        { code: "CONFLICT", message: "Already bound (API key not created)" },
        { status: 409 },
      ),
    );
    const conflict = await expectJson(
      await request(app, "POST", undefined, {
        name: "x",
        organizationId: "org_convex_1",
      }),
    );
    // The route's error mapper decorates it as it does every refusal here.
    expect(conflict.status).toBe(409);
    expect(conflict.data).toMatchObject({
      code: "CONFLICT",
      message: "Already bound (API key not created)",
    });

    stubNetwork(() =>
      Response.json(
        { code: "RATE_LIMITED", message: "Slow down" },
        { status: 429 },
      ),
    );
    const limited = await expectJson(await request(app, "GET"));
    expect(limited.status).toBe(429);
    expect(limited.data).toMatchObject({
      code: "RATE_LIMITED",
      message: "Slow down",
    });

    const errors = [{ field: "name", code: "name is invalid" }];
    stubNetwork(() =>
      Response.json(
        {
          code: "INTERNAL_ERROR",
          message: "Validation failed",
          details: { workosErrors: errors },
        },
        { status: 500 },
      ),
    );
    const failed = await expectJson(
      await request(app, "POST", undefined, {
        name: "x",
        organizationId: "org_convex_1",
      }),
    );
    expect(failed.status).toBe(500);
    expect(failed.data).toMatchObject({
      code: "INTERNAL_ERROR",
      details: { workosErrors: errors },
    });
  });

  it("leaves a key that is not the caller's own to the organization admin path", async () => {
    const calls = stubNetwork(() =>
      Response.json(
        { code: "NOT_FOUND", message: "API key not found" },
        { status: 404 },
      ),
    );

    const { status, data } = await expectJson(
      await request(app, "DELETE", "/api/web/api-keys/api_key_theirs"),
    );

    // Bound to no organization, so no admin may revoke it either.
    expect(status).toBe(404);
    expect(data).toMatchObject({ code: "NOT_FOUND" });
    expect(lookupWorkosKeyBinding).toHaveBeenCalledWith("api_key_theirs");
    // The backend already checked ownership; the Inspector doesn't again.
    expect(workosCalls(calls)).toEqual([]);
  });

  it("uses the in-Inspector path when the backend lacks the routes", async () => {
    const calls = stubNetwork(
      () =>
        new Response("No HttpAction routed for /web/api-keys", {
          status: 404,
        }),
    );

    const { status, data } = await expectJson(await request(app, "GET"));

    expect(status).toBe(200);
    expect(data).toEqual({ items: [] });
    expect(backendCalls(calls)).toHaveLength(1);
    expect(workosCalls(calls)).toHaveLength(1);
    expect(workosCalls(calls)[0].headers.get("authorization")).toBe(
      "Bearer sk_test_admin",
    );
  });

  it("uses the in-Inspector path while the switch is off", async () => {
    vi.stubEnv("MCPJAM_API_KEYS_VIA_BACKEND", "");
    const calls = stubNetwork(() => Response.json({ items: ["unexpected"] }));

    const { status, data } = await expectJson(await request(app, "GET"));

    expect(status).toBe(200);
    expect(data).toEqual({ items: [] });
    expect(backendCalls(calls)).toEqual([]);
  });

  it("never falls back after the backend was reached, so a mint can't run twice", async () => {
    const unreachable = stubNetwork(() => {
      throw new TypeError("fetch failed");
    });
    const failed = await expectJson(
      await request(app, "POST", undefined, {
        name: "x",
        organizationId: "org_convex_1",
      }),
    );
    expect(failed.status).toBe(502);
    expect(failed.data).toMatchObject({ code: "SERVER_UNREACHABLE" });
    expect(workosCalls(unreachable)).toEqual([]);

    const broken = stubNetwork(
      () => new Response("upstream error", { status: 503 }),
    );
    const garbled = await expectJson(
      await request(app, "POST", undefined, {
        name: "x",
        organizationId: "org_convex_1",
      }),
    );
    expect(garbled.status).toBe(502);
    expect(workosCalls(broken)).toEqual([]);
    expect(createWorkosKeyBinding).not.toHaveBeenCalled();
  });

  it("still refuses API keys and malformed bodies before the backend", async () => {
    const calls = stubNetwork(() => Response.json({ items: [] }));

    const key = await request(
      app,
      "GET",
      undefined,
      undefined,
      "Bearer sk_live_123",
    );
    expect(key.status).toBe(403);

    const invalid = await request(app, "POST", undefined, {
      name: "",
      organizationId: "org_convex_1",
    });
    expect(invalid.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
