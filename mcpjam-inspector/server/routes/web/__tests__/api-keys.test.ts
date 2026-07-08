import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebTestApp, expectJson } from "./helpers/test-app.js";

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

vi.mock("../../../services/identity.js", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    resolveUserByExternalId: vi.fn().mockResolvedValue({ _id: "mcpjam_user_1" }),
  };
});

const mockResolveApiKeyReadiness = vi.fn();
vi.mock("../../../services/organizations.js", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    resolveApiKeyReadiness: (...args: unknown[]) =>
      mockResolveApiKeyReadiness(...args),
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

async function deleteKey(app: ReturnType<typeof createWebTestApp>["app"], id: string) {
  return app.request(`/api/web/api-keys/${id}`, {
    method: "DELETE",
    headers: { Authorization: "Bearer session-jwt" },
  });
}

describe("web routes — API key revoke ownership", () => {
  const { app } = createWebTestApp();

  beforeEach(() => {
    vi.stubEnv("WORKOS_API_KEY", "sk_test_admin");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
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

async function mintKey(
  app: ReturnType<typeof createWebTestApp>["app"],
  organizationId = "org_convex_1",
) {
  return app.request("/api/web/api-keys", {
    method: "POST",
    headers: {
      Authorization: "Bearer session-jwt",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "my key", organizationId }),
  });
}

describe("web routes — API key mint readiness", () => {
  const { app } = createWebTestApp();

  beforeEach(() => {
    vi.stubEnv("WORKOS_API_KEY", "sk_test_admin");
    mockResolveApiKeyReadiness.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("mints a key once the backend reports the org+member ready", async () => {
    mockResolveApiKeyReadiness.mockResolvedValue({
      ready: true,
      workosOrganizationId: "org_workos_1",
    });
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname === USER_KEYS_PATH) {
        const body = JSON.parse(String(init.body));
        expect(body.organization_id).toBe("org_workos_1");
        return workosJson(keyRecord("api_key_new"));
      }
      return workosJson({ message: "unexpected WorkOS call" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { status } = await expectJson(await mintKey(app));

    expect(status).toBe(200);
    expect(mockResolveApiKeyReadiness).toHaveBeenCalledWith(
      "org_convex_1",
      "mcpjam_user_1",
    );
  });

  it("409s with a sync-timing message when the org is still pending", async () => {
    mockResolveApiKeyReadiness.mockResolvedValue({
      ready: false,
      workosOrganizationId: null,
      reason: "org_pending",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => workosJson({ message: "should not be called" }, 500)),
    );

    const { status, data } = await expectJson(await mintKey(app));

    expect(status).toBe(409);
    expect(data).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("409s with a sync-timing message when the caller's membership is still pending", async () => {
    mockResolveApiKeyReadiness.mockResolvedValue({
      ready: false,
      workosOrganizationId: "org_workos_1",
      reason: "membership_pending",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => workosJson({ message: "should not be called" }, 500)),
    );

    const { status, data } = await expectJson(await mintKey(app));

    expect(status).toBe(409);
    expect(data).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("403s when the caller has no membership row in the requested org", async () => {
    const { ApiKeyReadinessError } = await import(
      "../../../services/organizations.js"
    );
    mockResolveApiKeyReadiness.mockRejectedValue(
      new ApiKeyReadinessError(403, "Not a member of this organization"),
    );

    const { status, data } = await expectJson(await mintKey(app));

    expect(status).toBe(403);
    expect(data).toMatchObject({ code: "FORBIDDEN" });
  });

  it("404s when the requested org doesn't exist", async () => {
    const { ApiKeyReadinessError } = await import(
      "../../../services/organizations.js"
    );
    mockResolveApiKeyReadiness.mockRejectedValue(
      new ApiKeyReadinessError(404, "Organization not found"),
    );

    const { status, data } = await expectJson(await mintKey(app));

    expect(status).toBe(404);
    expect(data).toMatchObject({ code: "NOT_FOUND" });
  });

  it("400s when the readiness check reports malformed ids", async () => {
    const { ApiKeyReadinessError } = await import(
      "../../../services/organizations.js"
    );
    mockResolveApiKeyReadiness.mockRejectedValue(
      new ApiKeyReadinessError(400, "Invalid organization or user id"),
    );

    const { status, data } = await expectJson(await mintKey(app));

    expect(status).toBe(400);
    expect(data).toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("web routes — API key listing is not scoped by session org", () => {
  const { app } = createWebTestApp();

  beforeEach(() => {
    vi.stubEnv("WORKOS_API_KEY", "sk_test_admin");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("lists all of the user's keys without an organization_id filter", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(USER_KEYS_PATH);
      // Regression guard: a key minted under org B while the session is
      // scoped to org A must not be filtered out of this list.
      expect(url.searchParams.has("organization_id")).toBe(false);
      return workosJson({
        object: "list",
        data: [keyRecord("api_key_org_a"), keyRecord("api_key_org_b")],
        list_metadata: { before: null, after: null },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { status, data } = await expectJson(
      await app.request("/api/web/api-keys", {
        method: "GET",
        headers: { Authorization: "Bearer session-jwt" },
      }),
    );

    expect(status).toBe(200);
    expect(data.items).toHaveLength(2);
  });
});
