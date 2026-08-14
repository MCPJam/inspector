import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The org clamp on the project WRITE routes.
 *
 * The backend does not apply one: `projects:createProject` checks the acting
 * USER's membership in the requested org (`requireOrgRole`), the update/delete
 * mutations resolve project access from the same user, and `userMutation`
 * never reads the delegated-org claim. So an `sk_` key bound to org A, minted
 * by someone who also belongs to org B, could reach B's projects — the key's
 * promised scope is not the scope actually enforced.
 *
 * The gateway enforces it instead, mirroring the clamp the Convex
 * `/v1/projects` READ route already applies. These tests are the proof, and
 * the session-JWT cases are here to prove the clamp does NOT overreach: a
 * signed-in person is confined to nothing and must keep full access to every
 * org they belong to.
 */

const {
  validateGuestTokenMock,
  convexQueryMock,
  convexMutationMock,
  validateApiKeyMock,
  resolveUserByExternalIdMock,
  lookupWorkosKeyBindingMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  convexQueryMock: vi.fn(),
  convexMutationMock: vi.fn(),
  validateApiKeyMock: vi.fn(),
  resolveUserByExternalIdMock: vi.fn(),
  lookupWorkosKeyBindingMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("../../../services/workos-client.js", () => ({
  getWorkOSClient: () => ({
    apiKeys: { createValidation: validateApiKeyMock },
  }),
}));

vi.mock("../../../services/identity.js", () => ({
  resolveUserByExternalId: resolveUserByExternalIdMock,
}));

vi.mock("../../../services/workos-key-bindings.js", () => ({
  lookupWorkosKeyBinding: lookupWorkosKeyBindingMock,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
    mutation: convexMutationMock,
  })),
}));

import v1Routes from "../index.js";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function request(
  method: string,
  path: string,
  body: Record<string, unknown> | undefined,
  token: string
): Promise<Response> {
  return Promise.resolve(
    makeApp().request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );
}

/** The user's projects across BOTH their orgs — what `getMyProjects` returns. */
const PROJECTS = [
  { _id: "proj_in_a", name: "Alpha project", organizationId: "org_a" },
  { _id: "proj_in_b", name: "Beta project", organizationId: "org_b" },
];

function stubDelegatedKeyBoundTo(organizationId: string): void {
  process.env.INSPECTOR_SERVICE_TOKEN = "svc_token";
  validateApiKeyMock.mockResolvedValue({
    apiKey: { id: "key_1", owner: { id: "workos_user_1" } },
  });
  resolveUserByExternalIdMock.mockResolvedValue({ _id: "convex_user_1" });
  lookupWorkosKeyBindingMock.mockResolvedValue({
    mcpjamOrganizationId: organizationId,
  });
  global.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          token: "delegated-jwt",
          expiresAt: Date.now() + 2 * 60 * 60 * 1000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
  ) as typeof fetch;
}

describe("project write routes: delegated org scope", () => {
  const originalEnv = {
    CONVEX_URL: process.env.CONVEX_URL,
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
    INSPECTOR_SERVICE_TOKEN: process.env.INSPECTOR_SERVICE_TOKEN,
  };
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    convexQueryMock.mockResolvedValue(PROJECTS);
    convexMutationMock.mockResolvedValue("proj_in_a");
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
  });

  describe("POST /v1/projects", () => {
    it("rejects an explicit organizationId outside the key's org", async () => {
      stubDelegatedKeyBoundTo("org_a");

      const res = await request(
        "POST",
        "/api/v1/projects",
        { name: "Sneaky", organizationId: "org_b" },
        "sk_live_secret"
      );

      expect(res.status).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe("FORBIDDEN");
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("fills in the key's org when none is supplied", async () => {
      // The likely agent call is `create_project {name}`. Left to the backend
      // that lands in the USER's default org, which need not be the key's.
      stubDelegatedKeyBoundTo("org_a");

      const res = await request(
        "POST",
        "/api/v1/projects",
        { name: "Fresh" },
        "sk_live_secret"
      );

      expect(res.status).toBe(201);
      expect(convexMutationMock).toHaveBeenCalledWith(
        "projects:createProject",
        expect.objectContaining({ name: "Fresh", organizationId: "org_a" })
      );
    });

    it("passes a matching organizationId through", async () => {
      stubDelegatedKeyBoundTo("org_a");

      const res = await request(
        "POST",
        "/api/v1/projects",
        { name: "Fine", organizationId: "org_a" },
        "sk_live_secret"
      );

      expect(res.status).toBe(201);
      expect(convexMutationMock).toHaveBeenCalledTimes(1);
    });

    it("leaves a session JWT caller free to pick any of their orgs", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects",
        { name: "Mine", organizationId: "org_b" },
        "jwt-session-token"
      );

      expect(res.status).toBe(201);
      expect(convexMutationMock).toHaveBeenCalledWith(
        "projects:createProject",
        expect.objectContaining({ organizationId: "org_b" })
      );
    });
  });

  describe("PATCH /v1/projects/:projectId", () => {
    it("404s a project in a sibling org rather than renaming it", async () => {
      stubDelegatedKeyBoundTo("org_a");

      const res = await request(
        "PATCH",
        "/api/v1/projects/proj_in_b",
        { name: "Renamed by the wrong key" },
        "sk_live_secret"
      );

      // 404, not 403: a 403 would confirm the project exists to a key that
      // may not see it, and an unknown id already answers 404 here.
      expect(res.status).toBe(404);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("updates a project inside the key's own org", async () => {
      stubDelegatedKeyBoundTo("org_a");

      const res = await request(
        "PATCH",
        "/api/v1/projects/proj_in_a",
        { name: "Renamed" },
        "sk_live_secret"
      );

      expect(res.status).toBe(200);
      expect(convexMutationMock).toHaveBeenCalledWith(
        "projects:updateProject",
        expect.objectContaining({ projectId: "proj_in_a", name: "Renamed" })
      );
    });

    it("leaves a session JWT caller able to update either org's project", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/proj_in_b",
        { name: "Renamed" },
        "jwt-session-token"
      );

      expect(res.status).toBe(200);
      expect(convexMutationMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("DELETE /v1/projects/:projectId", () => {
    it("404s a project in a sibling org rather than deleting it", async () => {
      stubDelegatedKeyBoundTo("org_a");

      const res = await request(
        "DELETE",
        "/api/v1/projects/proj_in_b",
        undefined,
        "sk_live_secret"
      );

      expect(res.status).toBe(404);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });
});
