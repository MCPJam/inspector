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
