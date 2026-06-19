import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Covers the v1 HOST surface (server/routes/v1/hosts.ts): auth + guest gating,
// the public DTO mapping (no Convex `hostId` leak), the project-scoped Convex
// calls (every detail/write forwards the path `projectId` so cross-project ids
// 404 inside Convex), and the body contracts — create's template-XOR-config
// rule and delete's "no body, reject stray fields like a legacy `force`".
//
// Convex is mocked at the `convex/browser` boundary, so these tests prove the
// gateway's behavior and the ARGS it forwards — NOT that the backend accepts
// those args. The backend validators + project scoping are covered separately
// by mcpjam-backend/tests/convex/hostsProjectScope.test.ts.

const {
  validateGuestTokenMock,
  validateApiKeyMock,
  resolveUserByExternalIdMock,
  lookupWorkosKeyBindingMock,
  convexQueryMock,
  convexMutationMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  validateApiKeyMock: vi.fn(),
  resolveUserByExternalIdMock: vi.fn(),
  lookupWorkosKeyBindingMock: vi.fn(),
  convexQueryMock: vi.fn(),
  convexMutationMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

// WorkOS API-key seams — only reached by `sk_` bearers (none here), but the
// auth middleware imports them at module load, so stub them out.
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

// The host routes build their Convex clients via `new ConvexHttpClient(...)`
// (directly and through `createConvexClients`), so a single mock here backs
// both the read (`query`) and write (`mutation`) paths.
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
  opts: { body?: unknown; token?: string | null } = {}
): Promise<Response> {
  const { body, token = "tok" } = opts;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return Promise.resolve(
    makeApp().request(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );
}

const LIST_ROW = {
  hostId: "h1",
  name: "Alpha",
  hostConfigId: "hc1",
  modelId: "gpt-4o-mini",
  serverCount: 2,
  createdAt: 1,
  updatedAt: 2,
};
const DETAIL_ROW = {
  hostId: "h1",
  name: "Alpha",
  config: { modelId: "gpt-4o-mini" },
};

/** Dispatch the mocked Convex query by function name. */
function mockQuery(map: Record<string, unknown>) {
  convexQueryMock.mockImplementation(async (fn: string) =>
    fn in map ? map[fn] : null
  );
}

describe("v1 host routes", () => {
  const originalEnv = {
    CONVEX_URL: process.env.CONVEX_URL,
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    // Default: the bearer is neither a guest token nor an `sk_` key, so the
    // middleware treats it as a WorkOS JWT and passes it through to Convex.
    validateGuestTokenMock.mockResolvedValue({ valid: false });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
  });

  describe("auth", () => {
    it("rejects a request with no bearer token (401)", async () => {
      const res = await request("GET", "/api/v1/projects/p1/hosts", {
        token: null,
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "UNAUTHORIZED"
      );
    });

    it("denies guest callers — hosts are not on the guest allowlist (401)", async () => {
      validateGuestTokenMock.mockResolvedValue({
        valid: true,
        guestId: "guest_1",
      });
      const res = await request("GET", "/api/v1/projects/p1/hosts", {
        token: "guest-jwt",
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "UNAUTHORIZED"
      );
      expect(convexQueryMock).not.toHaveBeenCalled();
    });
  });

  describe("GET list + detail", () => {
    it("lists hosts in the public DTO shape (id, no hostId leak)", async () => {
      mockQuery({ "hosts:listHosts": [LIST_ROW] });
      const res = await request("GET", "/api/v1/projects/p1/hosts");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Record<string, unknown>[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({ id: "h1", name: "Alpha" });
      expect(body.items[0]).not.toHaveProperty("hostId");
      expect(convexQueryMock).toHaveBeenCalledWith("hosts:listHosts", {
        projectId: "p1",
      });
    });

    it("returns host detail and forwards the path projectId to getHost", async () => {
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      const res = await request("GET", "/api/v1/projects/p1/hosts/h1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ id: "h1", name: "Alpha" });
      expect(body).not.toHaveProperty("hostId");
      // Project scope is enforced inside Convex — the route must pass projectId.
      expect(convexQueryMock).toHaveBeenCalledWith("hosts:getHost", {
        hostId: "h1",
        projectId: "p1",
      });
    });

    it("returns 404 when getHost yields null (missing or cross-project id)", async () => {
      mockQuery({ "hosts:getHost": null });
      const res = await request("GET", "/api/v1/projects/p1/hosts/other");
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code?: string }).code).toBe("NOT_FOUND");
    });
  });

  describe("POST create", () => {
    it("creates a host from a full config and returns 201", async () => {
      convexMutationMock.mockResolvedValue({ hostId: "h1" });
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      const res = await request("POST", "/api/v1/projects/p1/hosts", {
        body: { name: "Alpha", config: { modelId: "gpt-4o-mini" } },
      });
      expect(res.status).toBe(201);
      expect((await res.json()) as Record<string, unknown>).toMatchObject({
        id: "h1",
      });
      expect(convexMutationMock).toHaveBeenCalledWith("hosts:createHost", {
        projectId: "p1",
        name: "Alpha",
        input: { modelId: "gpt-4o-mini" },
      });
    });

    it("rejects a body with neither template nor config (400)", async () => {
      const res = await request("POST", "/api/v1/projects/p1/hosts", {
        body: { name: "Alpha" },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "VALIDATION_ERROR"
      );
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });

  describe("PATCH update", () => {
    it("updates a host and forwards the path projectId to updateHost", async () => {
      convexMutationMock.mockResolvedValue({ hostId: "h1" });
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      const res = await request("PATCH", "/api/v1/projects/p1/hosts/h1", {
        body: { name: "Renamed" },
      });
      expect(res.status).toBe(200);
      expect(convexMutationMock).toHaveBeenCalledWith("hosts:updateHost", {
        hostId: "h1",
        projectId: "p1",
        name: "Renamed",
      });
    });

    it("rejects an empty update (no name or config) with 400", async () => {
      const res = await request("PATCH", "/api/v1/projects/p1/hosts/h1", {
        body: {},
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "VALIDATION_ERROR"
      );
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });

  describe("DELETE", () => {
    it("deletes a host, forwarding only { hostId, projectId } (no force)", async () => {
      convexMutationMock.mockResolvedValue(undefined);
      const res = await request("DELETE", "/api/v1/projects/p1/hosts/h1");
      expect(res.status).toBe(200);
      expect((await res.json()) as Record<string, unknown>).toEqual({
        id: "h1",
        deleted: true,
      });
      expect(convexMutationMock).toHaveBeenCalledWith("hosts:deleteHost", {
        hostId: "h1",
        projectId: "p1",
      });
    });

    it("rejects a delete body carrying a legacy `force` field (400)", async () => {
      const res = await request("DELETE", "/api/v1/projects/p1/hosts/h1", {
        body: { force: true },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string; message?: string };
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.message).toContain("force");
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });
});
