/**
 * The Inspector side of the backend's service-token binding routes.
 *
 * Route tests exercise these through `fetch` stubs keyed on pathname; this file
 * pins the parsing and status mapping the routes rely on, where a mistake
 * would read as the wrong authorization decision: an undeployed route taken
 * for "not found", or a missing expiry taken for "expired".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizeOrganizationKeyRevoke,
  createWorkosKeyBinding,
  lookupWorkosKeyBinding,
  removeOrganizationKeyBinding,
  WorkosKeyBindingError,
} from "../workos-key-bindings.js";
import { resolveApiKeyReadiness } from "../organizations.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ARGS = {
  organizationId: "org-1",
  actorUserId: "mcpjam_user_1",
  workosApiKeyId: "api_key_1",
};

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("lookupWorkosKeyBinding", () => {
  it("returns the binding's expiry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ ok: true, mcpjamOrganizationId: "org-1", expiresAt: 1234 }),
      ),
    );
    expect(await lookupWorkosKeyBinding("api_key_1")).toEqual({
      mcpjamOrganizationId: "org-1",
      expiresAt: 1234,
    });
  });

  it("reads a missing or null expiry as no expiry, never as expired", async () => {
    for (const body of [
      { ok: true, mcpjamOrganizationId: "org-1" },
      { ok: true, mcpjamOrganizationId: "org-1", expiresAt: null },
      { ok: true, mcpjamOrganizationId: "org-1", expiresAt: "soon" },
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => json(body)),
      );
      expect((await lookupWorkosKeyBinding("api_key_1"))?.expiresAt).toBeNull();
    }
  });
});

describe("createWorkosKeyBinding", () => {
  const BINDING = {
    workosApiKeyId: "api_key_1",
    mcpjamOrganizationId: "org-1",
    mintedByUserId: "mcpjam_user_1",
  };

  it("carries the backend's reason code with a refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          {
            ok: false,
            error:
              "Only organization owners and admins can create API keys in this organization",
            code: "ADMINS_ONLY",
          },
          403,
        ),
      ),
    );
    const error = await createWorkosKeyBinding(BINDING).catch((e) => e);
    expect(error).toBeInstanceOf(WorkosKeyBindingError);
    expect(error.status).toBe(403);
    expect(error.code).toBe("ADMINS_ONLY");
    expect(error.message).toBe(
      "Only organization owners and admins can create API keys in this organization",
    );
  });

  it("leaves the code unset when the backend sends none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ ok: false, error: "Internal error" }, 500)),
    );
    const error = await createWorkosKeyBinding(BINDING).catch((e) => e);
    expect(error).toBeInstanceOf(WorkosKeyBindingError);
    expect(error.status).toBe(500);
    expect(error.code).toBeUndefined();
  });
});

describe("authorizeOrganizationKeyRevoke", () => {
  it("resolves on a yes, sending the admin's MCPJam id and the service token", async () => {
    const fetchMock = vi.fn(async () =>
      json({ ok: true, mintedByUserId: "member_1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(authorizeOrganizationKeyRevoke(ARGS)).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe(
      "/internal/v1/organization-api-keys/revoke-authorization",
    );
    expect(Object.fromEntries(parsed.searchParams)).toEqual(ARGS);
    expect(
      (init.headers as Record<string, string>)["x-inspector-service-token"],
    ).toBe("service-test");
  });

  it.each([403, 400])("relays a %s refusal as a decision", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ ok: false, error: "no" }, status)),
    );
    const error = await authorizeOrganizationKeyRevoke(ARGS).catch((e) => e);
    expect(error).toBeInstanceOf(WorkosKeyBindingError);
    expect(error.status).toBe(status);
  });

  it("relays the entity-level 404 as not found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ ok: false, error: "API key not found" }, 404)),
    );
    const error = await authorizeOrganizationKeyRevoke(ARGS).catch((e) => e);
    expect(error).toBeInstanceOf(WorkosKeyBindingError);
    expect(error.status).toBe(404);
  });

  it.each([
    [
      "a route that is not deployed",
      new Response("Not found", { status: 404 }),
    ],
    ["a backend fault", json({ ok: false, error: "Internal error" }, 500)],
  ])("gives no decision at all for %s", async (_label, response) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const error = await authorizeOrganizationKeyRevoke(ARGS).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(WorkosKeyBindingError);
  });
});

describe("removeOrganizationKeyBinding", () => {
  it("DELETEs the org-scoped binding route", async () => {
    const fetchMock = vi.fn(async () => json({ ok: true, deleted: true }));
    vi.stubGlobal("fetch", fetchMock);

    await removeOrganizationKeyBinding(ARGS);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.method).toBe("DELETE");
    expect(new URL(url).pathname).toBe("/internal/v1/organization-api-keys");
  });

  it("throws with the status on a refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ ok: false }, 403)),
    );
    const error = await removeOrganizationKeyBinding(ARGS).catch((e) => e);
    expect(error).toBeInstanceOf(WorkosKeyBindingError);
    expect(error.status).toBe(403);
  });

  it("treats a 404 the backend answers as nothing left to remove", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ ok: false, error: "Binding not found" }, 404)),
    );
    await expect(removeOrganizationKeyBinding(ARGS)).resolves.toBeUndefined();
  });

  it("throws on a 404 from a route that is not there", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not found", { status: 404 })),
    );
    const error = await removeOrganizationKeyBinding(ARGS).catch((e) => e);
    expect(error).toBeInstanceOf(WorkosKeyBindingError);
    expect(error.status).toBe(404);
  });
});

describe("resolveApiKeyReadiness", () => {
  it("reports whether the caller may mint, and under which floor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          ready: true,
          workosOrganizationId: "org_workos_1",
          mintAllowed: false,
          mintMinimumRole: "admin",
        }),
      ),
    );
    expect(await resolveApiKeyReadiness("org-1", "user-1")).toMatchObject({
      ready: true,
      mintAllowed: false,
      mintMinimumRole: "admin",
    });
  });

  it("leaves the mint answer undefined for a backend that predates it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ ready: true, workosOrganizationId: "org_w" })),
    );
    const readiness = await resolveApiKeyReadiness("org-1", "user-1");
    expect(readiness.mintAllowed).toBeUndefined();
    expect(readiness.mintMinimumRole).toBeUndefined();
  });
});
