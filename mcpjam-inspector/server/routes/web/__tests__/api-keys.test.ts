import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";

// The session bearer is verified in-route (resolveSessionContext); stub it to
// a fixed WorkOS user so tests exercise the WorkOS REST flow, not JWT crypto.
vi.mock("../../../services/authkit-jwt.js", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    verifyAuthKitToken: vi.fn().mockResolvedValue({
      sub: "user_session_1",
      orgId: undefined,
    }),
  };
});

// Convex binding writes are out of scope here — keep the real
// WorkosKeyBindingError class but neuter the network calls.
vi.mock("../../../services/workos-key-bindings.js", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    createWorkosKeyBinding: vi.fn().mockResolvedValue(undefined),
    removeWorkosKeyBinding: vi.fn().mockResolvedValue(undefined),
  };
});

const OWNED_KEY_ID = "api_key_owned_1";
const USER_KEYS_PATH = "/user_management/users/user_session_1/api_keys";

function workosJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function keyRecord(id: string) {
  return {
    object: "api_key",
    id,
    owner: { type: "user", id: "user_session_1" },
    name: id,
  };
}

async function createApiKeysTestApp(hostedMode: boolean): Promise<Hono> {
  vi.resetModules();
  vi.doMock("../../../config.js", async (importOriginal) => {
    const actual = await importOriginal<object>();
    return { ...actual, HOSTED_MODE: hostedMode };
  });
  const { createWebTestApp } = await import("./helpers/test-app.js");
  return createWebTestApp().app;
}

async function expectJson<T = unknown>(
  response: Response,
): Promise<{ status: number; data: T }> {
  return {
    status: response.status,
    data: (await response.json()) as T,
  };
}

/**
 * Stub WorkOS: serve the user-scoped key list from `pages` (each entry is one
 * page; `list_metadata.after` chains them) and accept the admin DELETE.
 */
function stubWorkOS(pages: Array<{ data: unknown[]; after?: string | null }>) {
  const deleted: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === USER_KEYS_PATH) {
      const after = url.searchParams.get("after");
      const index = after ? Number(after.replace("cursor_", "")) : 0;
      const page = pages[index];
      if (!page) {
        return workosJson({ message: "bad cursor" }, 400);
      }
      return workosJson({
        object: "list",
        data: page.data,
        list_metadata: { before: null, after: page.after ?? null },
      });
    }
    if (method === "DELETE" && url.pathname.startsWith("/api_keys/")) {
      deleted.push(decodeURIComponent(url.pathname.slice("/api_keys/".length)));
      return new Response(null, { status: 204 });
    }
    return workosJson({ message: "unexpected WorkOS call" }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, deleted };
}

async function deleteKey(app: Hono, id: string) {
  return app.request(`/api/web/api-keys/${id}`, {
    method: "DELETE",
    headers: { Authorization: "Bearer session-jwt" },
  });
}

describe("web routes — API key revoke ownership", () => {
  let app: Hono;

  beforeEach(async () => {
    app = await createApiKeysTestApp(true);
    vi.stubEnv("WORKOS_API_KEY", "sk_test_admin");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.doUnmock("../../../config.js");
  });

  it("revokes a key that appears in the session user's list", async () => {
    const { deleted } = stubWorkOS([
      { data: [keyRecord("api_key_other"), keyRecord(OWNED_KEY_ID)] },
    ]);

    const { status, data } = await expectJson(await deleteKey(app, OWNED_KEY_ID));

    expect(status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(deleted).toEqual([OWNED_KEY_ID]);
  });

  it("404s for a foreign or unknown key id without calling DELETE", async () => {
    const { deleted, fetchMock } = stubWorkOS([
      { data: [keyRecord("api_key_other")] },
    ]);

    const { status, data } = await expectJson(
      await deleteKey(app, "api_key_someone_elses"),
    );

    expect(status).toBe(404);
    expect(data).toMatchObject({ code: "NOT_FOUND" });
    expect(deleted).toEqual([]);
    // Only the ownership list walk ran.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("finds a key on a later page of the list", async () => {
    const { deleted, fetchMock } = stubWorkOS([
      { data: [keyRecord("api_key_other")], after: "cursor_1" },
      { data: [keyRecord(OWNED_KEY_ID)] },
    ]);

    const { status, data } = await expectJson(await deleteKey(app, OWNED_KEY_ID));

    expect(status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(deleted).toEqual([OWNED_KEY_ID]);
    // Two list pages + one DELETE.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const secondListUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(secondListUrl.searchParams.get("after")).toBe("cursor_1");
  });

  it("errors (not 404) when the page cap is exhausted with pages remaining", async () => {
    // Every page points at itself, so the walk never terminates naturally.
    const { deleted } = stubWorkOS([
      { data: [keyRecord("api_key_other")], after: "cursor_0" },
    ]);

    const { status, data } = await expectJson(
      await deleteKey(app, "api_key_beyond_cap"),
    );

    expect(status).toBe(500);
    expect(data).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Could not verify API key ownership",
    });
    expect(deleted).toEqual([]);
  });
});

// Local mode forwards the whole sub-router to the hosted app — see the proxy
// middleware in api-keys.ts. WORKOS_API_KEY is deliberately SET here: an MCP
// developer's own WorkOS key in the shell env must not flip the inspector into
// local minting against their WorkOS account.
describe("web routes — API key local-mode proxy to hosted", () => {
  let app: Hono;
  const REMOTE_BASE = "https://hosted.example/api/web/api-keys";

  beforeEach(async () => {
    app = await createApiKeysTestApp(false);
    vi.stubEnv("WORKOS_API_KEY", "sk_users_own_key");
    vi.stubEnv("MCPJAM_REMOTE_API_KEYS_URL", REMOTE_BASE);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.doUnmock("../../../config.js");
  });

  function stubHosted(response: Response) {
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("forwards create requests verbatim and passes the response through", async () => {
    const created = { id: "api_key_new", name: "ci", value: "sk_secret" };
    const fetchMock = stubHosted(workosJson(created));

    const response = await app.request("/api/web/api-keys", {
      method: "POST",
      headers: {
        Authorization: "Bearer session-jwt",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "ci", organizationId: "org_1" }),
    });
    const { status, data } = await expectJson(response);

    expect(status).toBe(200);
    expect(data).toEqual(created);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(target).toBe(REMOTE_BASE);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer session-jwt",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      name: "ci",
      organizationId: "org_1",
    });
  });

  it("forwards the key id path segment on revoke", async () => {
    const fetchMock = stubHosted(workosJson({ ok: true }));

    const { status, data } = await expectJson(
      await deleteKey(app, "api_key_remote_1"),
    );

    expect(status).toBe(200);
    expect(data).toEqual({ ok: true });
    const [target, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(target).toBe(`${REMOTE_BASE}/api_key_remote_1`);
    expect(init.method).toBe("DELETE");
  });

  it("passes hosted error responses through untouched", async () => {
    stubHosted(
      workosJson({ code: "UNAUTHORIZED", message: "Invalid session" }, 401),
    );

    const response = await app.request("/api/web/api-keys", {
      method: "GET",
      headers: { Authorization: "Bearer session-jwt" },
    });
    const { status, data } = await expectJson(response);

    expect(status).toBe(401);
    expect(data).toEqual({ code: "UNAUTHORIZED", message: "Invalid session" });
  });

  it("maps an unreachable hosted app to 502 SERVER_UNREACHABLE", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );

    const response = await app.request("/api/web/api-keys", {
      method: "GET",
      headers: { Authorization: "Bearer session-jwt" },
    });
    const { status, data } = await expectJson(response);

    expect(status).toBe(502);
    expect(data).toMatchObject({ code: "SERVER_UNREACHABLE" });
  });

  it("still rejects sk_ bearers locally without calling hosted", async () => {
    const fetchMock = stubHosted(workosJson({}));

    const response = await app.request("/api/web/api-keys", {
      method: "GET",
      headers: { Authorization: "Bearer sk_live_123" },
    });
    const { status, data } = await expectJson(response);

    expect(status).toBe(403);
    expect(data).toMatchObject({ code: "FORBIDDEN" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
