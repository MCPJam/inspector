import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebTestApp, expectJson } from "./helpers/test-app.js";
import { resolveUserByExternalId } from "../../../services/identity.js";
import { logger } from "../../../utils/logger.js";
import {
  createWorkosKeyBinding,
  lookupWorkosKeyBinding,
  removeWorkosKeyBinding,
  WorkosKeyBindingError,
} from "../../../services/workos-key-bindings.js";
import { setRevokedSessionCacheForTests } from "../../../services/revoked-session-cache.js";

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
    lookupWorkosKeyBinding: vi
      .fn()
      .mockResolvedValue({ mcpjamOrganizationId: "org-1" }),
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

const mockResolveApiKeyReadiness = vi.fn();
vi.mock("../../../services/organizations.js", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    resolveApiKeyReadiness: (...args: unknown[]) =>
      mockResolveApiKeyReadiness(...args),
  };
});

// These tests cover the routes themselves, in a process without the
// revoked-session list. How the list gates them is covered in
// `server/__tests__/session-revocation.test.ts` (MJ-011).
beforeEach(() => setRevokedSessionCacheForTests(null));
afterEach(() => setRevokedSessionCacheForTests(undefined));

const OWNED_KEY_ID = "api_key_owned_1";
const USER_KEYS_PATH = "/user_management/users/user_session_1/api_keys";
const ADMINS_ONLY_MESSAGE =
  "Only organization owners and admins can create API keys in this organization. Ask an owner or admin to create one for you, or to allow members to create keys.";

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

async function deleteKey(
  app: ReturnType<typeof createWebTestApp>["app"],
  id: string,
) {
  return app.request(`/api/web/api-keys/${id}`, {
    method: "DELETE",
    headers: { Authorization: "Bearer session-jwt" },
  });
}

describe("web routes — API key revoke ownership", () => {
  const { app } = createWebTestApp();

  beforeEach(() => {
    vi.stubEnv("WORKOS_API_KEY", "sk_test_admin");
    vi.mocked(removeWorkosKeyBinding).mockClear();
    vi.mocked(removeWorkosKeyBinding).mockResolvedValue(undefined);
    vi.mocked(resolveUserByExternalId).mockResolvedValue({
      _id: "mcpjam_user_1",
    } as Awaited<ReturnType<typeof resolveUserByExternalId>>);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("revokes a key that appears in the session user's list", async () => {
    const { deleted } = stubWorkOS([
      { data: [keyRecord("api_key_other"), keyRecord(OWNED_KEY_ID)] },
    ]);

    const { status, data } = await expectJson(
      await deleteKey(app, OWNED_KEY_ID),
    );

    expect(status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(deleted).toEqual([OWNED_KEY_ID]);
  });

  it("404s for an unknown key id without calling DELETE", async () => {
    // Not in the caller's list, and bound to no organization.
    vi.mocked(lookupWorkosKeyBinding).mockResolvedValueOnce(null);
    const { deleted, fetchMock } = stubWorkOS([
      { data: [keyRecord("api_key_other")] },
    ]);

    const { status, data } = await expectJson(
      await deleteKey(app, "api_key_unknown"),
    );

    expect(status).toBe(404);
    expect(data).toMatchObject({ code: "NOT_FOUND" });
    expect(deleted).toEqual([]);
    expect(lookupWorkosKeyBinding).toHaveBeenCalledWith("api_key_unknown");
    // Only the ownership list walk ran.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("finds a key on a later page of the list", async () => {
    const { deleted, fetchMock } = stubWorkOS([
      { data: [keyRecord("api_key_other")], after: "cursor_1" },
      { data: [keyRecord(OWNED_KEY_ID)] },
    ]);

    const { status, data } = await expectJson(
      await deleteKey(app, OWNED_KEY_ID),
    );

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

  it("names the revoking user on the binding delete", async () => {
    stubWorkOS([{ data: [keyRecord(OWNED_KEY_ID)] }]);

    const { status } = await expectJson(await deleteKey(app, OWNED_KEY_ID));

    expect(status).toBe(200);
    // The MCPJam user id, not the WorkOS `sub` — the backend validates it as a
    // Convex document id and 400s the other one.
    expect(removeWorkosKeyBinding).toHaveBeenCalledWith(
      OWNED_KEY_ID,
      "mcpjam_user_1",
    );
  });

  it("still revokes, unattributed, when the caller has no MCPJam user row", async () => {
    vi.mocked(resolveUserByExternalId).mockResolvedValue(
      null as Awaited<ReturnType<typeof resolveUserByExternalId>>,
    );
    const { deleted } = stubWorkOS([{ data: [keyRecord(OWNED_KEY_ID)] }]);

    const { status } = await expectJson(await deleteKey(app, OWNED_KEY_ID));

    // The key is gone either way; an unresolvable actor costs attribution, not
    // the revoke.
    expect(status).toBe(200);
    expect(deleted).toEqual([OWNED_KEY_ID]);
    expect(removeWorkosKeyBinding).toHaveBeenCalledWith(
      OWNED_KEY_ID,
      undefined,
    );
  });

  it("keeps the revoke successful when the binding delete is refused", async () => {
    vi.mocked(removeWorkosKeyBinding).mockRejectedValue(
      new WorkosKeyBindingError(403, "Binding remove failed (403)"),
    );
    const { deleted } = stubWorkOS([{ data: [keyRecord(OWNED_KEY_ID)] }]);

    const { status, data } = await expectJson(
      await deleteKey(app, OWNED_KEY_ID),
    );

    // The WorkOS key is already destroyed by this point. Failing the response
    // would tell the user a revoke did not happen when it did.
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(deleted).toEqual([OWNED_KEY_ID]);
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
    const { ApiKeyReadinessError } =
      await import("../../../services/organizations.js");
    mockResolveApiKeyReadiness.mockRejectedValue(
      new ApiKeyReadinessError(403, "Not a member of this organization"),
    );

    const { status, data } = await expectJson(await mintKey(app));

    expect(status).toBe(403);
    expect(data).toMatchObject({ code: "FORBIDDEN" });
  });

  it("404s when the requested org doesn't exist", async () => {
    const { ApiKeyReadinessError } =
      await import("../../../services/organizations.js");
    mockResolveApiKeyReadiness.mockRejectedValue(
      new ApiKeyReadinessError(404, "Organization not found"),
    );

    const { status, data } = await expectJson(await mintKey(app));

    expect(status).toBe(404);
    expect(data).toMatchObject({ code: "NOT_FOUND" });
  });

  it("409s when the key id is already bound to a different organization", async () => {
    mockResolveApiKeyReadiness.mockResolvedValue({
      ready: true,
      workosOrganizationId: "org_workos_1",
    });
    vi.mocked(createWorkosKeyBinding).mockRejectedValueOnce(
      new WorkosKeyBindingError(
        409,
        "This API key is already bound to a different organization",
      ),
    );
    const deleted: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname === USER_KEYS_PATH) {
        return workosJson(keyRecord("api_key_new"));
      }
      if (init?.method === "DELETE" && url.pathname.startsWith("/api_keys/")) {
        deleted.push(
          decodeURIComponent(url.pathname.slice("/api_keys/".length)),
        );
        return new Response(null, { status: 204 });
      }
      return workosJson({ message: "unexpected WorkOS call" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { status, data } = await expectJson(await mintKey(app));

    // A conflict, not a 502: the backend was reachable and answered clearly.
    expect(status).toBe(409);
    expect(data).toMatchObject({ code: "CONFLICT" });
    // And the just-minted WorkOS key is destroyed, so no unbindable key lives on.
    expect(deleted).toEqual(["api_key_new"]);
  });

  it("400s when the readiness check reports malformed ids", async () => {
    const { ApiKeyReadinessError } =
      await import("../../../services/organizations.js");
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
    vi.mocked(lookupWorkosKeyBinding)
      .mockReset()
      .mockResolvedValue({ mcpjamOrganizationId: "org-1" });
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

  it("pages through a multi-page key list instead of returning only the first page", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const after = url.searchParams.get("after");
      if (!after) {
        return workosJson({
          object: "list",
          data: [keyRecord("api_key_page_1")],
          list_metadata: { before: null, after: "cursor_1" },
        });
      }
      expect(after).toBe("cursor_1");
      return workosJson({
        object: "list",
        data: [keyRecord("api_key_page_2")],
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
    expect(data.items.map((k: { id: string }) => k.id)).toEqual([
      "api_key_page_1",
      "api_key_page_2",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("labels keys with their bound org, and leaves a key unlabeled when its lookup fails", async () => {
    vi.mocked(lookupWorkosKeyBinding)
      .mockResolvedValueOnce({ mcpjamOrganizationId: "org-a" })
      .mockRejectedValueOnce(
        new Error(
          "Binding lookup route not found at https://convex.internal/x — is the backend bindings route deployed?",
        ),
      );
    stubWorkOS([{ data: [keyRecord("api_key_1"), keyRecord("api_key_2")] }]);

    const response = await app.request("/api/web/api-keys", {
      method: "GET",
      headers: { Authorization: "Bearer session-jwt" },
    });
    const { status, data } = await expectJson(response);

    expect(status).toBe(200);
    expect(
      data.items.map(
        (k: { organizationId: string | null }) => k.organizationId,
      ),
    ).toEqual(["org-a", null]);
    // The internal URL from the lookup error must never reach the client.
    expect(JSON.stringify(data)).not.toContain("convex.internal");
  });

  it("never lets binding lookups fan out past the concurrency bound", async () => {
    let inFlight = 0;
    let peak = 0;
    vi.mocked(lookupWorkosKeyBinding).mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { mcpjamOrganizationId: "org-a" };
    });
    stubWorkOS([
      { data: Array.from({ length: 40 }, (_, i) => keyRecord(`api_key_${i}`)) },
    ]);

    const { status, data } = await expectJson(
      await app.request("/api/web/api-keys", {
        method: "GET",
        headers: { Authorization: "Bearer session-jwt" },
      }),
    );

    expect(status).toBe(200);
    expect(data.items).toHaveLength(40);
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("organization API key inventory", () => {
  const { app } = createWebTestApp();
  beforeEach(() => {
    vi.stubEnv("WORKOS_API_KEY", "sk_test_admin");
    vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-test");
    mockResolveApiKeyReadiness.mockReset().mockResolvedValue({
      ready: true,
      workosOrganizationId: "org_workos_1",
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.mocked(lookupWorkosKeyBinding)
      .mockReset()
      .mockResolvedValue({ mcpjamOrganizationId: "org-1" });
  });

  it("400s a blank organization id before touching the backend", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await app.request("/api/web/api-keys/organization/%20", {
      headers: { Authorization: "Bearer session-jwt" },
    });
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("403s a non-member from the membership floor, even if the backend would answer", async () => {
    const { ApiKeyReadinessError } =
      await import("../../../services/organizations.js");
    mockResolveApiKeyReadiness.mockRejectedValue(
      new ApiKeyReadinessError(403, "Not a member of this organization"),
    );
    const fetchMock = vi.fn().mockResolvedValue(workosJson({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await app.request("/api/web/api-keys/organization/org-1", {
      headers: { Authorization: "Bearer session-jwt" },
    });
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("walks owners' WorkOS key lists with bounded concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const owners = Array.from({ length: 12 }, (_, i) => `workos-${i}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("organization-api-keys"))
          return workosJson({
            items: owners.map((externalId, i) => ({
              workosApiKeyId: `key-${i}`,
              owner: {
                id: `owner-${i}`,
                name: `Owner ${i}`,
                email: `${externalId}@test.local`,
                externalId,
              },
            })),
          });
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        const match = /users\/(workos-\d+)\//.exec(String(url));
        const i = Number(match?.[1].replace("workos-", ""));
        return workosJson({ data: [{ id: `key-${i}`, name: `Key ${i}` }] });
      }),
    );
    const response = await app.request("/api/web/api-keys/organization/org-1", {
      headers: { Authorization: "Bearer session-jwt" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("drops a key the backend returned whose own binding points at another org", async () => {
    vi.mocked(lookupWorkosKeyBinding).mockImplementation(async (id) => ({
      mcpjamOrganizationId: id === "key-a" ? "org-1" : "org-other",
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("organization-api-keys"))
          return workosJson({
            items: ["key-a", "key-b"].map((workosApiKeyId) => ({
              workosApiKeyId,
              owner: {
                id: "owner-a",
                name: "Alex",
                email: "alex@test.local",
                externalId: "workos-a",
              },
            })),
          });
        return workosJson({
          data: [
            { id: "key-a", name: "CI" },
            { id: "key-b", name: "Leaked" },
          ],
        });
      }),
    );
    const response = await app.request("/api/web/api-keys/organization/org-1", {
      headers: { Authorization: "Bearer session-jwt" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.map((k: { id: string }) => k.id)).toEqual(["key-a"]);
  });

  it("rejects non-admins before reading anyone's WorkOS keys", async () => {
    const fetchMock = vi.fn().mockResolvedValue(workosJson({}, 403));
    vi.stubGlobal("fetch", fetchMock);
    const response = await app.request("/api/web/api-keys/organization/org-1", {
      headers: { Authorization: "Bearer session-jwt" },
    });
    expect(response.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "actorUserId=mcpjam_user_1",
    );
  });

  it("returns only bound keys and safe owner metadata, never secret values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("organization-api-keys"))
          return workosJson({
            items: [
              {
                workosApiKeyId: "key-a",
                owner: {
                  id: "owner-a",
                  name: "Alex",
                  email: "alex@test.local",
                  externalId: "workos-a",
                },
              },
            ],
          });
        return workosJson({
          data: [
            {
              id: "key-a",
              name: "CI",
              obfuscated_value: "sk_…123",
              value: "SECRET",
            },
            { id: "other-org-key", name: "Private" },
          ],
        });
      }),
    );
    const response = await app.request("/api/web/api-keys/organization/org-1", {
      headers: { Authorization: "Bearer session-jwt" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: "key-a",
      organizationId: "org-1",
      owner: { name: "Alex", email: "alex@test.local" },
    });
    expect(body.items[0]).not.toHaveProperty("value");
    expect(body.items[0].owner).not.toHaveProperty("externalId");
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

async function mintWith(
  app: ReturnType<typeof createWebTestApp>["app"],
  extra: Record<string, unknown>,
) {
  return app.request("/api/web/api-keys", {
    method: "POST",
    headers: {
      Authorization: "Bearer session-jwt",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "my key",
      organizationId: "org_convex_1",
      ...extra,
    }),
  });
}

describe("web routes — API key expiry at mint", () => {
  const { app } = createWebTestApp();

  beforeEach(() => {
    vi.stubEnv("WORKOS_API_KEY", "sk_test_admin");
    mockResolveApiKeyReadiness.mockReset().mockResolvedValue({
      ready: true,
      workosOrganizationId: "org_workos_1",
      mintAllowed: true,
      mintMinimumRole: "member",
    });
    vi.mocked(createWorkosKeyBinding).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /** Echo the create body back the way WorkOS does, `expires_at` included. */
  function stubMint(onCreate?: (body: any) => Response | undefined) {
    const creates: any[] = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname === USER_KEYS_PATH) {
        const body = JSON.parse(String(init.body));
        creates.push(body);
        const override = onCreate?.(body);
        if (override) return override;
        return workosJson({
          ...keyRecord("api_key_new"),
          value: "test-plaintext-value",
          expires_at: body.expires_at ?? null,
        });
      }
      return workosJson({ message: "unexpected WorkOS call" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { creates, fetchMock };
  }

  it("expires a key in 90 days when the caller does not say", async () => {
    const { creates } = stubMint();
    const before = Date.now();

    const { status, data } = await expectJson<{ expires_at: string }>(
      await mintWith(app, {}),
    );

    expect(status).toBe(200);
    const sent = Date.parse(creates[0].expires_at);
    expect(sent - before).toBeGreaterThanOrEqual(90 * DAY_MS - 1_000);
    expect(sent - before).toBeLessThanOrEqual(90 * DAY_MS + 60_000);
    // The binding records the SAME instant WorkOS was given.
    expect(createWorkosKeyBinding).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: sent }),
    );
    expect(data.expires_at).toBe(new Date(sent).toISOString());
  });

  it("honours a caller-chosen lifetime within bounds", async () => {
    const { creates } = stubMint();
    const before = Date.now();

    const { status } = await expectJson(
      await mintWith(app, { expiresInDays: 7 }),
    );

    expect(status).toBe(200);
    const sent = Date.parse(creates[0].expires_at);
    expect(sent - before).toBeGreaterThanOrEqual(7 * DAY_MS - 1_000);
    expect(sent - before).toBeLessThanOrEqual(7 * DAY_MS + 60_000);
  });

  it.each([0, 366, 2.5, -1])(
    "400s expiresInDays=%s before WorkOS is asked for anything",
    async (expiresInDays) => {
      const { fetchMock } = stubMint();

      const { status, data } = await expectJson<{ code: string }>(
        await mintWith(app, { expiresInDays }),
      );

      expect(status).toBe(400);
      expect(data.code).toBe("VALIDATION_ERROR");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(createWorkosKeyBinding).not.toHaveBeenCalled();
    },
  );

  it("still mints, and still binds the expiry, if WorkOS refuses the expires_at field", async () => {
    const event = vi.spyOn(logger, "event");
    const { creates } = stubMint((body) =>
      body.expires_at
        ? workosJson(
            {
              message: "Validation failed",
              errors: [{ field: "expires_at", code: "unsupported" }],
            },
            422,
          )
        : undefined,
    );

    const { status, data } = await expectJson<{ expires_at: string }>(
      await mintWith(app, {}),
    );

    expect(status).toBe(200);
    expect(creates).toHaveLength(2);
    expect(creates[1]).not.toHaveProperty("expires_at");
    const bound = vi.mocked(createWorkosKeyBinding).mock.calls[0][0].expiresAt;
    expect(typeof bound).toBe("number");
    // The response still says when the key stops working: MCPJam enforces it.
    expect(data.expires_at).toBe(new Date(bound as number).toISOString());
    // …and the lost WorkOS-native half is visible, not silent.
    expect(event).toHaveBeenCalledWith(
      "apikey.expiry.workos_refused",
      expect.anything(),
      { statusCode: 422 },
      undefined,
    );
    event.mockRestore();
  });

  it("does not retry on a WorkOS validation error about something else", async () => {
    const { creates } = stubMint(() =>
      workosJson(
        {
          message: "Validation failed",
          errors: [{ field: "name", code: "too_long" }],
        },
        422,
      ),
    );

    const { status } = await expectJson(await mintWith(app, {}));

    expect(status).toBe(500);
    expect(creates).toHaveLength(1);
    expect(createWorkosKeyBinding).not.toHaveBeenCalled();
  });
});

describe("web routes — admin-only minting policy", () => {
  const { app } = createWebTestApp();

  beforeEach(() => {
    vi.stubEnv("WORKOS_API_KEY", "sk_test_admin");
    vi.mocked(createWorkosKeyBinding).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("403s a member under the default owners-and-admins setting before any WorkOS key exists", async () => {
    // What the readiness check reports for a member of an organization that
    // has not changed who may create keys (MJ-010).
    mockResolveApiKeyReadiness.mockReset().mockResolvedValue({
      ready: true,
      workosOrganizationId: "org_workos_1",
      mintAllowed: false,
      mintMinimumRole: "admin",
    });
    const fetchMock = vi.fn(async () =>
      workosJson({ message: "should not be called" }, 500),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { status, data } = await expectJson<{
      code: string;
      message: string;
    }>(await mintWith(app, {}));

    expect(status).toBe(403);
    expect(data.code).toBe("FORBIDDEN");
    expect(data.message).toBe(ADMINS_ONLY_MESSAGE);
    expect(mockResolveApiKeyReadiness).toHaveBeenCalledWith(
      "org_convex_1",
      "mcpjam_user_1",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createWorkosKeyBinding).not.toHaveBeenCalled();
  });

  it("refuses on policy before reporting a sync delay", async () => {
    mockResolveApiKeyReadiness.mockReset().mockResolvedValue({
      ready: false,
      workosOrganizationId: null,
      reason: "org_pending",
      mintAllowed: false,
      mintMinimumRole: "admin",
    });
    vi.stubGlobal("fetch", vi.fn());

    const { status } = await expectJson(await mintWith(app, {}));

    expect(status).toBe(403);
  });

  it("attempts the mint against a backend that predates the policy field", async () => {
    // No `mintAllowed` at all: the binding write still enforces the rule on
    // that backend, so the route must not invent a refusal.
    mockResolveApiKeyReadiness.mockReset().mockResolvedValue({
      ready: true,
      workosOrganizationId: "org_workos_1",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        workosJson({
          ...keyRecord("api_key_new"),
          value: "v",
          expires_at: null,
        }),
      ),
    );

    const { status } = await expectJson(await mintWith(app, {}));

    expect(status).toBe(200);
  });

  it("revokes the WorkOS key when the binding write refuses on policy", async () => {
    // The race: the policy changed between the readiness check and the bind.
    mockResolveApiKeyReadiness.mockReset().mockResolvedValue({
      ready: true,
      workosOrganizationId: "org_workos_1",
      mintAllowed: true,
    });
    vi.mocked(createWorkosKeyBinding).mockRejectedValueOnce(
      new WorkosKeyBindingError(
        403,
        "Only organization owners and admins can create API keys in this organization",
      ),
    );
    const deleted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (init?.method === "DELETE") {
          deleted.push(url.pathname);
          return new Response(null, { status: 204 });
        }
        return workosJson({ ...keyRecord("api_key_new"), value: "v" });
      }),
    );

    const { status, data } = await expectJson<{ code: string }>(
      await mintWith(app, {}),
    );

    expect(status).toBe(403);
    expect(data.code).toBe("FORBIDDEN");
    expect(deleted).toEqual(["/api_keys/api_key_new"]);
  });

  it("gives the readiness check's answer when the binding write names the organization's setting", async () => {
    mockResolveApiKeyReadiness.mockReset().mockResolvedValue({
      ready: true,
      workosOrganizationId: "org_workos_1",
      mintAllowed: true,
    });
    vi.mocked(createWorkosKeyBinding).mockRejectedValueOnce(
      new WorkosKeyBindingError(
        403,
        "Only organization owners and admins can create API keys in this organization",
        "ADMINS_ONLY",
      ),
    );
    const deleted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (init?.method === "DELETE") {
          deleted.push(url.pathname);
          return new Response(null, { status: 204 });
        }
        return workosJson({ ...keyRecord("api_key_new"), value: "v" });
      }),
    );

    const { status, data } = await expectJson<{
      code: string;
      message: string;
    }>(await mintWith(app, {}));

    expect(status).toBe(403);
    expect(data).toMatchObject({
      code: "FORBIDDEN",
      message: ADMINS_ONLY_MESSAGE,
    });
    expect(deleted).toEqual(["/api_keys/api_key_new"]);
  });
});

describe("web routes — personal key list reports expiry", () => {
  const { app } = createWebTestApp();

  beforeEach(() => {
    vi.stubEnv("WORKOS_API_KEY", "sk_test_admin");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.mocked(lookupWorkosKeyBinding)
      .mockReset()
      .mockResolvedValue({ mcpjamOrganizationId: "org-1" });
  });

  it("uses WorkOS's expiry, the binding's, or the earlier of the two", async () => {
    const workosExpiry = "2031-01-01T00:00:00.000Z";
    const bindingExpiry = Date.parse("2030-06-01T00:00:00.000Z");
    vi.mocked(lookupWorkosKeyBinding).mockImplementation(async (id) => ({
      mcpjamOrganizationId: "org-1",
      expiresAt:
        id === "key_both" || id === "key_binding" ? bindingExpiry : null,
    }));
    stubWorkOS([
      {
        data: [
          { ...keyRecord("key_workos"), expires_at: workosExpiry },
          { ...keyRecord("key_binding"), expires_at: null },
          { ...keyRecord("key_both"), expires_at: workosExpiry },
          { ...keyRecord("key_legacy"), expires_at: null },
        ],
      },
    ]);

    const { status, data } = await expectJson<{
      items: Array<{ id: string; expires_at: string | null }>;
    }>(
      await app.request("/api/web/api-keys", {
        headers: { Authorization: "Bearer session-jwt" },
      }),
    );

    expect(status).toBe(200);
    expect(
      Object.fromEntries(data.items.map((k) => [k.id, k.expires_at])),
    ).toEqual({
      key_workos: workosExpiry,
      key_binding: new Date(bindingExpiry).toISOString(),
      key_both: new Date(bindingExpiry).toISOString(),
      // Minted before expiry existed: it keeps working, and says so.
      key_legacy: null,
    });
  });
});

describe("organization API key inventory — completeness", () => {
  const { app } = createWebTestApp();
  beforeEach(() => {
    vi.stubEnv("WORKOS_API_KEY", "sk_test_admin");
    vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-test");
    mockResolveApiKeyReadiness.mockReset().mockResolvedValue({
      ready: true,
      workosOrganizationId: "org_workos_1",
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.mocked(lookupWorkosKeyBinding)
      .mockReset()
      .mockResolvedValue({ mcpjamOrganizationId: "org-1" });
  });

  function stubInventory(backendBody: unknown, workosKeys: unknown[] = []) {
    const backendUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("organization-api-keys")) {
          backendUrls.push(String(url));
          return workosJson(backendBody);
        }
        return workosJson({ data: workosKeys });
      }),
    );
    return { backendUrls };
  }

  it("lists a key whose minter account is gone, as an unknown user", async () => {
    const mintedAt = Date.parse("2026-01-02T03:04:05.000Z");
    const expiresAt = Date.parse("2026-04-02T03:04:05.000Z");
    const { backendUrls } = stubInventory({
      items: [
        {
          workosApiKeyId: "key-orphaned",
          mintedAt,
          expiresAt,
          owner: null,
        },
      ],
      truncated: false,
    });

    const response = await app.request("/api/web/api-keys/organization/org-1", {
      headers: { Authorization: "Bearer session-jwt" },
    });

    expect(response.status).toBe(200);
    // Asked for explicitly: the backend leaves these out for older callers.
    expect(new URL(backendUrls[0]).searchParams.get("includeOwnerless")).toBe(
      "1",
    );
    const body = await response.json();
    expect(body.items).toEqual([
      {
        id: "key-orphaned",
        name: null,
        obfuscated_value: null,
        created_at: new Date(mintedAt).toISOString(),
        last_used_at: null,
        expires_at: new Date(expiresAt).toISOString(),
        organizationId: "org-1",
        owner: null,
      },
    ]);
  });

  it("lists a key whose minter has no WorkOS identity with the owner it does know", async () => {
    stubInventory({
      items: [
        {
          workosApiKeyId: "key-no-identity",
          mintedAt: Date.now(),
          expiresAt: null,
          owner: {
            id: "owner-x",
            name: "Xan",
            email: "xan@test.local",
            externalId: null,
          },
        },
      ],
    });

    const response = await app.request("/api/web/api-keys/organization/org-1", {
      headers: { Authorization: "Bearer session-jwt" },
    });
    const body = await response.json();

    expect(body.items).toMatchObject([
      {
        id: "key-no-identity",
        name: null,
        expires_at: null,
        owner: { id: "owner-x", name: "Xan", email: "xan@test.local" },
      },
    ]);
  });

  it("lists from the binding a key whose minter WorkOS no longer knows, without failing the rest", async () => {
    const owner = (externalId: string, name: string) => ({
      id: `owner-${name}`,
      name,
      email: `${name}@test.local`,
      externalId,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("organization-api-keys"))
          return workosJson({
            items: [
              {
                workosApiKeyId: "key-live",
                owner: owner("workos-live", "Liv"),
              },
              {
                workosApiKeyId: "key-gone",
                mintedAt: 1,
                owner: owner("workos-gone", "Gus"),
              },
            ],
          });
        if (String(url).includes("workos-gone"))
          return workosJson({ message: "User not found" }, 404);
        return workosJson({ data: [{ id: "key-live", name: "CI" }] });
      }),
    );

    const response = await app.request("/api/web/api-keys/organization/org-1", {
      headers: { Authorization: "Bearer session-jwt" },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.items.map((k: { id: string; name: string | null }) => [
        k.id,
        k.name,
      ]),
    ).toEqual([
      ["key-live", "CI"],
      ["key-gone", null],
    ]);
    expect(body.items[1].owner).toMatchObject({ name: "Gus" });
  });

  it("still drops an ownerless key whose own binding points elsewhere", async () => {
    vi.mocked(lookupWorkosKeyBinding).mockResolvedValue({
      mcpjamOrganizationId: "org-other",
    });
    stubInventory({
      items: [{ workosApiKeyId: "key-orphaned", mintedAt: 1, owner: null }],
    });

    const response = await app.request("/api/web/api-keys/organization/org-1", {
      headers: { Authorization: "Bearer session-jwt" },
    });

    expect((await response.json()).items).toEqual([]);
  });

  it("passes the backend's truncation flag through for the page to warn about", async () => {
    stubInventory({ items: [], truncated: true });

    const response = await app.request("/api/web/api-keys/organization/org-1", {
      headers: { Authorization: "Bearer session-jwt" },
    });

    expect(await response.json()).toEqual({ items: [], truncated: true });
  });

  it("reports expiry for keys found at WorkOS, and not truncated by default", async () => {
    const workosExpiry = "2030-01-01T00:00:00.000Z";
    stubInventory(
      {
        items: [
          {
            workosApiKeyId: "key-a",
            owner: {
              id: "owner-a",
              name: "Alex",
              email: "alex@test.local",
              externalId: "workos-a",
            },
          },
        ],
      },
      [{ id: "key-a", name: "CI", expires_at: workosExpiry }],
    );

    const response = await app.request("/api/web/api-keys/organization/org-1", {
      headers: { Authorization: "Bearer session-jwt" },
    });
    const body = await response.json();

    expect(body.truncated).toBe(false);
    expect(body.items[0]).toMatchObject({
      id: "key-a",
      expires_at: workosExpiry,
    });
  });
});

describe("organization API key revoke (owners and admins)", () => {
  const { app } = createWebTestApp();
  const REVOKE_URL = "/api/web/api-keys/organization/org-1/key-members";

  beforeEach(() => {
    vi.stubEnv("WORKOS_API_KEY", "sk_test_admin");
    vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-test");
    mockResolveApiKeyReadiness.mockReset().mockResolvedValue({
      ready: true,
      workosOrganizationId: "org_workos_1",
    });
    vi.mocked(resolveUserByExternalId).mockResolvedValue({
      _id: "mcpjam_user_1",
    } as Awaited<ReturnType<typeof resolveUserByExternalId>>);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /**
   * Stub both hops. `calls` records every request in order as
   * "<METHOD> <host><path>", so the tests can assert the authorization ran
   * BEFORE the irreversible WorkOS delete. `bindingDelete` is one answer for
   * every binding delete, or a function of the attempt number (from 1).
   */
  function stubRevoke(opts: {
    authorize?: Response;
    workosDelete?: Response;
    bindingDelete?: Response | ((attempt: number) => Response);
  }) {
    const calls: string[] = [];
    const urls: URL[] = [];
    let bindingDeletes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        calls.push(`${method} ${url.host}${url.pathname}`);
        urls.push(url);
        if (url.pathname.endsWith("/revoke-authorization")) {
          return (
            opts.authorize ??
            workosJson({ ok: true, mintedByUserId: "member_1" })
          );
        }
        if (url.pathname === "/internal/v1/organization-api-keys") {
          bindingDeletes += 1;
          if (typeof opts.bindingDelete === "function")
            return opts.bindingDelete(bindingDeletes);
          return (
            opts.bindingDelete?.clone() ??
            workosJson({ ok: true, deleted: true })
          );
        }
        if (method === "DELETE" && url.pathname.startsWith("/api_keys/")) {
          return opts.workosDelete ?? new Response(null, { status: 204 });
        }
        return workosJson({ message: "unexpected call" }, 500);
      }),
    );
    return { calls, urls };
  }

  function revoke(url = REVOKE_URL) {
    return app.request(url, {
      method: "DELETE",
      headers: { Authorization: "Bearer session-jwt" },
    });
  }

  it("authorizes, then revokes at WorkOS, then drops the binding — in that order", async () => {
    const { calls, urls } = stubRevoke({});

    const { status, data } = await expectJson(await revoke());

    expect(status).toBe(200);
    expect(data).toEqual({ ok: true, alreadyRevoked: false });
    expect(calls).toEqual([
      "GET backend.test/internal/v1/organization-api-keys/revoke-authorization",
      "DELETE api.workos.com/api_keys/key-members",
      "DELETE backend.test/internal/v1/organization-api-keys",
    ]);
    // The admin is named by MCPJam id, not WorkOS `sub`, on both backend hops.
    for (const url of [urls[0], urls[2]]) {
      expect(Object.fromEntries(url.searchParams)).toEqual({
        organizationId: "org-1",
        actorUserId: "mcpjam_user_1",
        workosApiKeyId: "key-members",
      });
    }
  });

  it("403s a caller the backend refuses, and never touches WorkOS", async () => {
    const { calls } = stubRevoke({
      authorize: workosJson(
        {
          ok: false,
          error: "Not allowed to manage API keys for this organization",
        },
        403,
      ),
    });

    const { status, data } = await expectJson<{ code: string }>(await revoke());

    expect(status).toBe(403);
    expect(data.code).toBe("FORBIDDEN");
    expect(calls).toHaveLength(1);
  });

  it("404s a key this org does not hold, and never touches WorkOS", async () => {
    const { calls } = stubRevoke({
      authorize: workosJson({ ok: false, error: "API key not found" }, 404),
    });

    const { status, data } = await expectJson<{ code: string }>(await revoke());

    expect(status).toBe(404);
    expect(data.code).toBe("NOT_FOUND");
    expect(calls).toHaveLength(1);
  });

  it("refuses rather than revoking when the backend has no authorization route yet", async () => {
    // An older backend 404s the path itself (not the entity-level body). No
    // decision means no revoke.
    const { calls } = stubRevoke({
      authorize: new Response("Not found", { status: 404 }),
    });

    const { status, data } = await expectJson<{
      code: string;
      message: string;
    }>(await revoke());

    expect(status).toBe(502);
    expect(data.code).toBe("SERVER_UNREACHABLE");
    expect(data.message).not.toContain("backend.test");
    expect(calls).toHaveLength(1);
  });

  it("403s a non-member at the membership floor before asking to authorize", async () => {
    const { ApiKeyReadinessError } =
      await import("../../../services/organizations.js");
    mockResolveApiKeyReadiness.mockRejectedValue(
      new ApiKeyReadinessError(403, "Not a member of this organization"),
    );
    const { calls } = stubRevoke({});

    const { status } = await expectJson(await revoke());

    expect(status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("treats a key WorkOS no longer has as already revoked, and still drops the binding", async () => {
    const { calls } = stubRevoke({
      workosDelete: workosJson({ message: "ApiKey not found" }, 404),
    });

    const { status, data } = await expectJson(await revoke());

    expect(status).toBe(200);
    expect(data).toEqual({ ok: true, alreadyRevoked: true });
    expect(calls.at(-1)).toBe(
      "DELETE backend.test/internal/v1/organization-api-keys",
    );
  });

  it("fails without dropping the binding when WorkOS cannot revoke", async () => {
    const { calls } = stubRevoke({
      workosDelete: workosJson({ message: "upstream exploded" }, 500),
    });

    const { status } = await expectJson(await revoke());

    expect(status).toBe(500);
    // The key is still live at WorkOS, so its binding must stay: the admin
    // retries from the same row.
    expect(calls).not.toContain(
      "DELETE backend.test/internal/v1/organization-api-keys",
    );
  });

  describe("binding cleanup", () => {
    const BINDING_DELETE =
      "DELETE backend.test/internal/v1/organization-api-keys";

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Run a revoke to its answer, stepping fake time through any waits. */
    async function revokeToCompletion() {
      const pending = Promise.resolve(revoke());
      let settled = false;
      void pending.then(
        () => (settled = true),
        () => (settled = true),
      );
      for (let step = 0; step < 40 && !settled; step++) {
        await vi.advanceTimersByTimeAsync(100);
      }
      return pending;
    }

    it("tries again after a 503 and records the removal on the second attempt", async () => {
      const event = vi.spyOn(logger, "event");
      const { calls } = stubRevoke({
        bindingDelete: (attempt) =>
          attempt === 1
            ? workosJson({ ok: false, error: "Service Unavailable" }, 503)
            : workosJson({ ok: true, deleted: true }),
      });

      const { status, data } = await expectJson(await revokeToCompletion());

      expect(status).toBe(200);
      expect(data).toEqual({ ok: true, alreadyRevoked: false });
      expect(calls.filter((call) => call === BINDING_DELETE)).toHaveLength(2);
      expect(event).toHaveBeenCalledWith(
        "apikey.admin_revoke.completed",
        expect.anything(),
        {
          workosKeyId: "key-members",
          alreadyRevoked: false,
          bindingCleanupFailed: false,
          bindingCleanupAttempts: 2,
        },
        undefined,
      );
      event.mockRestore();
    });

    it("tries again after a transport failure", async () => {
      const { calls } = stubRevoke({
        bindingDelete: (attempt) => {
          if (attempt === 1) throw new TypeError("fetch failed");
          return workosJson({ ok: true, deleted: true });
        },
      });

      const { status } = await expectJson(await revokeToCompletion());

      expect(status).toBe(200);
      expect(calls.filter((call) => call === BINDING_DELETE)).toHaveLength(2);
    });

    it("still reports success after three failed attempts, and raises the leftover binding", async () => {
      const event = vi.spyOn(logger, "event");
      const { calls } = stubRevoke({
        bindingDelete: workosJson({ ok: false, error: "Internal error" }, 500),
      });

      const { status, data } = await expectJson(await revokeToCompletion());

      // The key is gone at WorkOS, so the revoke itself succeeded.
      expect(status).toBe(200);
      expect(data).toEqual({ ok: true, alreadyRevoked: false });
      expect(calls.filter((call) => call === BINDING_DELETE)).toHaveLength(3);
      // The leftover binding is recorded with its cause, not lost.
      expect(event).toHaveBeenCalledWith(
        "apikey.admin_revoke.completed",
        expect.anything(),
        {
          workosKeyId: "key-members",
          alreadyRevoked: false,
          bindingCleanupFailed: true,
          bindingCleanupAttempts: 3,
          bindingStatus: 500,
        },
        { error: expect.any(WorkosKeyBindingError), sentry: true },
      );
      event.mockRestore();
    });

    it("does not try again after a 403", async () => {
      const event = vi.spyOn(logger, "event");
      const { calls } = stubRevoke({
        bindingDelete: workosJson(
          {
            ok: false,
            error: "Not allowed to manage API keys for this organization",
          },
          403,
        ),
      });

      const { status } = await expectJson(await revokeToCompletion());

      expect(status).toBe(200);
      expect(calls.filter((call) => call === BINDING_DELETE)).toHaveLength(1);
      expect(event).toHaveBeenCalledWith(
        "apikey.admin_revoke.completed",
        expect.anything(),
        expect.objectContaining({
          bindingCleanupFailed: true,
          bindingCleanupAttempts: 1,
          bindingStatus: 403,
        }),
        { error: expect.any(WorkosKeyBindingError), sentry: true },
      );
      event.mockRestore();
    });
  });

  it("refuses an sk_ key outright — keys cannot revoke keys", async () => {
    const { calls } = stubRevoke({});

    const response = await app.request(REVOKE_URL, {
      method: "DELETE",
      headers: { Authorization: "Bearer sk_test_some_key" },
    });

    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("API key revoke by id for organization owners and admins", () => {
  const { app } = createWebTestApp();
  const MEMBER_KEY_ID = "api_key_member_1";
  const LIST_WALK = `GET api.workos.com${USER_KEYS_PATH}`;

  beforeEach(() => {
    vi.stubEnv("WORKOS_API_KEY", "sk_test_admin");
    vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-test");
    mockResolveApiKeyReadiness.mockReset().mockResolvedValue({
      ready: true,
      workosOrganizationId: "org_workos_1",
    });
    vi.mocked(resolveUserByExternalId).mockResolvedValue({
      _id: "mcpjam_user_1",
    } as Awaited<ReturnType<typeof resolveUserByExternalId>>);
    vi.mocked(lookupWorkosKeyBinding)
      .mockReset()
      .mockResolvedValue({ mcpjamOrganizationId: "org-1" });
    vi.mocked(removeWorkosKeyBinding).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.mocked(lookupWorkosKeyBinding)
      .mockReset()
      .mockResolvedValue({ mcpjamOrganizationId: "org-1" });
  });

  /**
   * The caller's own WorkOS key list (holding only OWNED_KEY_ID), the
   * backend's organization key routes, and the WorkOS delete. `calls` records
   * every request in order as "<METHOD> <host><path>".
   */
  function stubRevokeById(opts: { authorize?: Response } = {}) {
    const calls: string[] = [];
    const urls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        calls.push(`${method} ${url.host}${url.pathname}`);
        urls.push(url);
        if (method === "GET" && url.pathname === USER_KEYS_PATH) {
          return workosJson({
            object: "list",
            data: [keyRecord(OWNED_KEY_ID)],
            list_metadata: { before: null, after: null },
          });
        }
        if (url.pathname.endsWith("/revoke-authorization")) {
          return (
            opts.authorize ??
            workosJson({ ok: true, mintedByUserId: "member_1" })
          );
        }
        if (url.pathname === "/internal/v1/organization-api-keys") {
          return workosJson({ ok: true, deleted: true });
        }
        if (method === "DELETE" && url.pathname.startsWith("/api_keys/")) {
          return new Response(null, { status: 204 });
        }
        return workosJson({ message: "unexpected call" }, 500);
      }),
    );
    return { calls, urls };
  }

  it("lets an organization owner revoke a member's key: authorize, then WorkOS, then the binding", async () => {
    const { calls, urls } = stubRevokeById();

    const { status, data } = await expectJson(
      await deleteKey(app, MEMBER_KEY_ID),
    );

    expect(status).toBe(200);
    expect(data).toEqual({ ok: true, alreadyRevoked: false });
    expect(lookupWorkosKeyBinding).toHaveBeenCalledWith(MEMBER_KEY_ID);
    expect(mockResolveApiKeyReadiness).toHaveBeenCalledWith(
      "org-1",
      "mcpjam_user_1",
    );
    expect(calls).toEqual([
      LIST_WALK,
      "GET backend.test/internal/v1/organization-api-keys/revoke-authorization",
      `DELETE api.workos.com/api_keys/${MEMBER_KEY_ID}`,
      "DELETE backend.test/internal/v1/organization-api-keys",
    ]);
    // The organization is the one the key is bound to; the actor is the
    // caller's MCPJam id, on both backend hops.
    for (const url of [urls[1], urls[3]]) {
      expect(Object.fromEntries(url.searchParams)).toEqual({
        organizationId: "org-1",
        actorUserId: "mcpjam_user_1",
        workosApiKeyId: MEMBER_KEY_ID,
      });
    }
    // The minter's own binding removal belongs to the personal revoke.
    expect(removeWorkosKeyBinding).not.toHaveBeenCalled();
  });

  it("answers a member who is not an admin with the unknown-id 404, and leaves the key alone", async () => {
    const { calls } = stubRevokeById({
      authorize: workosJson(
        {
          ok: false,
          error: "Not allowed to manage API keys for this organization",
        },
        403,
      ),
    });

    const { status, data } = await expectJson<{
      code: string;
      message: string;
    }>(await deleteKey(app, MEMBER_KEY_ID));

    expect(status).toBe(404);
    expect(data).toMatchObject({
      code: "NOT_FOUND",
      message: "API key not found",
    });
    expect(calls).toEqual([
      LIST_WALK,
      "GET backend.test/internal/v1/organization-api-keys/revoke-authorization",
    ]);
    expect(removeWorkosKeyBinding).not.toHaveBeenCalled();
  });

  it("answers someone outside the key's organization with 404 before asking to authorize", async () => {
    const { ApiKeyReadinessError } =
      await import("../../../services/organizations.js");
    mockResolveApiKeyReadiness.mockRejectedValue(
      new ApiKeyReadinessError(403, "Not a member of this organization"),
    );
    const { calls } = stubRevokeById();

    const { status, data } = await expectJson<{ code: string }>(
      await deleteKey(app, MEMBER_KEY_ID),
    );

    expect(status).toBe(404);
    expect(data.code).toBe("NOT_FOUND");
    expect(calls).toEqual([LIST_WALK]);
  });

  it("refuses with 502, and leaves the key alone, when the key's organization cannot be read", async () => {
    vi.mocked(lookupWorkosKeyBinding).mockRejectedValueOnce(
      new Error("Binding lookup failed (500)"),
    );
    const { calls } = stubRevokeById();

    const { status, data } = await expectJson<{
      code: string;
      message: string;
    }>(await deleteKey(app, MEMBER_KEY_ID));

    expect(status).toBe(502);
    expect(data.code).toBe("SERVER_UNREACHABLE");
    expect(data.message).not.toContain("Binding lookup");
    expect(calls).toEqual([LIST_WALK]);
  });

  it("refuses with 502 rather than revoking when the backend gives no decision", async () => {
    // A routing-level 404 (no entity body) is no decision at all.
    const { calls } = stubRevokeById({
      authorize: new Response("Not found", { status: 404 }),
    });

    const { status } = await expectJson(await deleteKey(app, MEMBER_KEY_ID));

    expect(status).toBe(502);
    expect(calls).not.toContain(
      `DELETE api.workos.com/api_keys/${MEMBER_KEY_ID}`,
    );
  });

  it("keeps the caller's own key on the personal revoke", async () => {
    const { calls } = stubRevokeById();

    const { status, data } = await expectJson(
      await deleteKey(app, OWNED_KEY_ID),
    );

    expect(status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(calls).toEqual([
      LIST_WALK,
      `DELETE api.workos.com/api_keys/${OWNED_KEY_ID}`,
    ]);
    expect(lookupWorkosKeyBinding).not.toHaveBeenCalled();
    expect(removeWorkosKeyBinding).toHaveBeenCalledWith(
      OWNED_KEY_ID,
      "mcpjam_user_1",
    );
  });
});

describe("API key list for one organization", () => {
  const { app } = createWebTestApp();

  beforeEach(() => {
    vi.stubEnv("WORKOS_API_KEY", "sk_test_admin");
    vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-test");
    mockResolveApiKeyReadiness.mockReset().mockResolvedValue({
      ready: true,
      workosOrganizationId: "org_workos_1",
    });
    vi.mocked(resolveUserByExternalId).mockResolvedValue({
      _id: "mcpjam_user_1",
    } as Awaited<ReturnType<typeof resolveUserByExternalId>>);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.mocked(lookupWorkosKeyBinding)
      .mockReset()
      .mockResolvedValue({ mcpjamOrganizationId: "org-1" });
  });

  function listKeys(path: string) {
    return app.request(path, {
      headers: { Authorization: "Bearer session-jwt" },
    });
  }

  /** The backend inventory answers `inventory`; WorkOS lists a member's key. */
  function stubInventory(inventory: Response) {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        requested.push(`${url.host}${url.pathname}`);
        if (url.pathname === "/internal/v1/organization-api-keys")
          return inventory.clone();
        return workosJson({
          data: [
            {
              id: "api_key_member_1",
              name: "CI",
              obfuscated_value: "sk_…abc",
            },
          ],
        });
      }),
    );
    return { requested };
  }

  const MEMBER_KEY_INVENTORY = {
    items: [
      {
        workosApiKeyId: "api_key_member_1",
        owner: {
          id: "member_1",
          name: "Morgan",
          email: "morgan@test.local",
          externalId: "workos-member-1",
        },
      },
    ],
  };

  it("gives an organization owner every key bound to the organization, a member's included", async () => {
    const { requested } = stubInventory(workosJson(MEMBER_KEY_INVENTORY));

    const { status, data } = await expectJson<{
      items: Array<Record<string, unknown>>;
      truncated: boolean;
    }>(await listKeys("/api/web/api-keys?organizationId=org-1"));

    expect(status).toBe(200);
    expect(data.truncated).toBe(false);
    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({
      id: "api_key_member_1",
      name: "CI",
      organizationId: "org-1",
      owner: { id: "member_1", name: "Morgan", email: "morgan@test.local" },
    });
    // The member's WorkOS list was read, not the caller's own.
    expect(requested).toEqual([
      "backend.test/internal/v1/organization-api-keys",
      "api.workos.com/user_management/users/workos-member-1/api_keys",
    ]);
  });

  it("gives a member who is not an admin the organization route's 403, without reading WorkOS", async () => {
    const { requested } = stubInventory(
      workosJson(
        {
          ok: false,
          error: "Not allowed to view API keys for this organization",
        },
        403,
      ),
    );

    const { status, data } = await expectJson<{
      code: string;
      message: string;
    }>(await listKeys("/api/web/api-keys?organizationId=org-1"));

    expect(status).toBe(403);
    expect(data).toMatchObject({
      code: "FORBIDDEN",
      message: "Only organization owners and admins can view API keys.",
    });
    expect(requested).toEqual([
      "backend.test/internal/v1/organization-api-keys",
    ]);
  });

  it.each([
    ["an owner", 200, MEMBER_KEY_INVENTORY],
    [
      "a member",
      403,
      {
        ok: false,
        error: "Not allowed to view API keys for this organization",
      },
    ],
  ])(
    "answers %s exactly as GET /organization/:organizationId does",
    async (_caller, backendStatus, backendBody) => {
      stubInventory(workosJson(backendBody, backendStatus));
      const viaQuery = await listKeys("/api/web/api-keys?organizationId=org-1");
      const viaPath = await listKeys("/api/web/api-keys/organization/org-1");

      expect(viaQuery.status).toBe(viaPath.status);
      expect(await viaQuery.json()).toEqual(await viaPath.json());
    },
  );

  it("400s a blank organizationId before touching the backend", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await listKeys("/api/web/api-keys?organizationId=%20");

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("API key creation eligibility", () => {
  const { app } = createWebTestApp();

  beforeEach(() => {
    vi.stubEnv("WORKOS_API_KEY", "sk_test_admin");
    mockResolveApiKeyReadiness.mockReset();
    vi.mocked(resolveUserByExternalId).mockResolvedValue({
      _id: "mcpjam_user_1",
    } as Awaited<ReturnType<typeof resolveUserByExternalId>>);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function eligibility(query = "?organizationId=org_convex_1") {
    return app.request(`/api/web/api-keys/mint-eligibility${query}`, {
      headers: { Authorization: "Bearer session-jwt" },
    });
  }

  it("tells a member that only owners and admins create keys, and returns nothing more", async () => {
    mockResolveApiKeyReadiness.mockResolvedValue({
      ready: true,
      workosOrganizationId: "org_workos_1",
      mintAllowed: false,
      mintMinimumRole: "admin",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { status, data } = await expectJson(await eligibility());

    expect(status).toBe(200);
    expect(data).toEqual({ mintAllowed: false, mintMinimumRole: "admin" });
    expect(mockResolveApiKeyReadiness).toHaveBeenCalledWith(
      "org_convex_1",
      "mcpjam_user_1",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tells an owner or admin they may create keys", async () => {
    mockResolveApiKeyReadiness.mockResolvedValue({
      ready: true,
      workosOrganizationId: "org_workos_1",
      mintAllowed: true,
      mintMinimumRole: "admin",
    });

    const { status, data } = await expectJson(await eligibility());

    expect(status).toBe(200);
    expect(data).toEqual({ mintAllowed: true, mintMinimumRole: "admin" });
  });

  it("reports no answer when the backend does not give one", async () => {
    mockResolveApiKeyReadiness.mockResolvedValue({
      ready: true,
      workosOrganizationId: "org_workos_1",
    });

    const { status, data } = await expectJson(await eligibility());

    expect(status).toBe(200);
    expect(data).toEqual({ mintAllowed: null, mintMinimumRole: null });
  });

  it("403s someone who is not a member of the organization", async () => {
    const { ApiKeyReadinessError } =
      await import("../../../services/organizations.js");
    mockResolveApiKeyReadiness.mockRejectedValue(
      new ApiKeyReadinessError(403, "Not a member of this organization"),
    );

    const { status, data } = await expectJson<{ code: string }>(
      await eligibility(),
    );

    expect(status).toBe(403);
    expect(data.code).toBe("FORBIDDEN");
  });

  it("400s a request that names no organization", async () => {
    const response = await eligibility("");

    expect(response.status).toBe(400);
    expect(mockResolveApiKeyReadiness).not.toHaveBeenCalled();
  });
});
