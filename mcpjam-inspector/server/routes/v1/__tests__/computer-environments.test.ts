import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Covers the v1 COMPUTER-ENVIRONMENTS surface
// (server/routes/v1/computer-environments.ts): auth + guest gating, the public
// DTO mapping (no Convex `environmentId`/`buildId` leak), and — the key
// difference from hosts — the route-level PROJECT-SCOPE GUARD. The backend env
// mutations take only an `environmentId` and authorize by the env's own
// project, so the route must itself prove the env belongs to the URL's
// `:projectId` (via `getEnvironment`) before mutating; a cross-project id reads
// as 404 and the mutation never runs.
//
// Convex is mocked at the `convex/browser` boundary, so these tests prove the
// gateway's behavior and the ARGS it forwards — not the backend's own checks.

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

const BUILD_ROW = {
  buildId: "b1",
  status: "ready",
  provider: "stub",
  baseImageDigests: ["sha256:abc"],
  createdAt: 1,
};
const ENV_ROW = {
  environmentId: "env1",
  projectId: "p1",
  name: "ml-toolkit",
  dockerfile: "FROM debian@sha256:x\nRUN echo hi",
  contentHash: "h",
  sharing: "user",
  isOwner: true,
  currentBuild: BUILD_ROW,
  createdAt: 1,
  updatedAt: 2,
};
// Same id, but owned by a DIFFERENT project — the scope guard must 404 it.
const CROSS_PROJECT_ENV = { ...ENV_ROW, projectId: "other" };

function mockQuery(map: Record<string, unknown>) {
  convexQueryMock.mockImplementation(async (fn: string) =>
    fn in map ? map[fn] : null
  );
}
function mockMutation(map: Record<string, unknown>) {
  convexMutationMock.mockImplementation(async (fn: string) =>
    fn in map ? map[fn] : null
  );
}

describe("v1 computer-environments routes", () => {
  const originalEnv = {
    CONVEX_URL: process.env.CONVEX_URL,
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
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
      const res = await request(
        "GET",
        "/api/v1/projects/p1/computer-environments",
        { token: null }
      );
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "UNAUTHORIZED"
      );
    });

    it("denies guest callers — environments are not on the guest allowlist (401)", async () => {
      validateGuestTokenMock.mockResolvedValue({
        valid: true,
        guestId: "guest_1",
      });
      const res = await request(
        "GET",
        "/api/v1/projects/p1/computer-environments",
        { token: "guest-jwt" }
      );
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "UNAUTHORIZED"
      );
      expect(convexQueryMock).not.toHaveBeenCalled();
    });
  });

  describe("GET list + detail", () => {
    it("lists environments in the public DTO shape (id, no environmentId leak)", async () => {
      mockQuery({ "computerEnvironments:listEnvironments": [ENV_ROW] });
      const res = await request(
        "GET",
        "/api/v1/projects/p1/computer-environments"
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Record<string, unknown>[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({ id: "env1", name: "ml-toolkit" });
      expect(body.items[0]).not.toHaveProperty("environmentId");
      expect(convexQueryMock).toHaveBeenCalledWith(
        "computerEnvironments:listEnvironments",
        { projectId: "p1" }
      );
    });

    it("returns environment detail and maps environmentId → id", async () => {
      mockQuery({ "computerEnvironments:getEnvironment": ENV_ROW });
      const res = await request(
        "GET",
        "/api/v1/projects/p1/computer-environments/env1"
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ id: "env1", name: "ml-toolkit" });
      expect(body).not.toHaveProperty("environmentId");
      expect(convexQueryMock).toHaveBeenCalledWith(
        "computerEnvironments:getEnvironment",
        { environmentId: "env1" }
      );
    });

    it("maps an infrastructure failure (timeout) to 5xx, not a 400 validation error", async () => {
      convexQueryMock.mockRejectedValueOnce(
        new Error("Request timed out after 30000ms")
      );
      const res = await request(
        "GET",
        "/api/v1/projects/p1/computer-environments"
      );
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(((await res.json()) as { code?: string }).code).not.toBe(
        "VALIDATION_ERROR"
      );
    });

    it("404s a missing environment", async () => {
      mockQuery({ "computerEnvironments:getEnvironment": null });
      const res = await request(
        "GET",
        "/api/v1/projects/p1/computer-environments/nope"
      );
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code?: string }).code).toBe("NOT_FOUND");
    });
  });

  describe("project-scope guard", () => {
    it("404s a GET for an env that belongs to another project", async () => {
      mockQuery({ "computerEnvironments:getEnvironment": CROSS_PROJECT_ENV });
      const res = await request(
        "GET",
        "/api/v1/projects/p1/computer-environments/env1"
      );
      expect(res.status).toBe(404);
    });

    it("404s a PATCH for a cross-project env WITHOUT calling the update mutation", async () => {
      mockQuery({ "computerEnvironments:getEnvironment": CROSS_PROJECT_ENV });
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/computer-environments/env1",
        { body: { name: "x" } }
      );
      expect(res.status).toBe(404);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("404s a DELETE for a cross-project env WITHOUT calling the delete mutation", async () => {
      mockQuery({ "computerEnvironments:getEnvironment": CROSS_PROJECT_ENV });
      const res = await request(
        "DELETE",
        "/api/v1/projects/p1/computer-environments/env1"
      );
      expect(res.status).toBe(404);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });

  describe("POST create", () => {
    it("creates an environment and returns 201, forwarding name + dockerfile", async () => {
      mockMutation({ "computerEnvironments:createEnvironment": ENV_ROW });
      const res = await request(
        "POST",
        "/api/v1/projects/p1/computer-environments",
        { body: { name: "ml-toolkit", dockerfile: "FROM debian@sha256:x" } }
      );
      expect(res.status).toBe(201);
      expect((await res.json()) as Record<string, unknown>).toMatchObject({
        id: "env1",
      });
      expect(convexMutationMock).toHaveBeenCalledWith(
        "computerEnvironments:createEnvironment",
        { projectId: "p1", name: "ml-toolkit", dockerfile: "FROM debian@sha256:x" }
      );
    });

    it("rejects an empty dockerfile (400)", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/computer-environments",
        { body: { name: "x", dockerfile: "" } }
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "VALIDATION_ERROR"
      );
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });

  describe("PATCH / DELETE (in-project)", () => {
    it("updates an in-project env, forwarding only environmentId + changed fields", async () => {
      mockQuery({ "computerEnvironments:getEnvironment": ENV_ROW });
      mockMutation({
        "computerEnvironments:updateEnvironment": { ...ENV_ROW, name: "renamed" },
      });
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/computer-environments/env1",
        { body: { name: "renamed" } }
      );
      expect(res.status).toBe(200);
      expect(convexMutationMock).toHaveBeenCalledWith(
        "computerEnvironments:updateEnvironment",
        { environmentId: "env1", name: "renamed" }
      );
    });

    it("rejects a delete body carrying a stray field (400, bodyless contract)", async () => {
      const res = await request(
        "DELETE",
        "/api/v1/projects/p1/computer-environments/env1",
        { body: { force: true } }
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message?: string }).message).toContain(
        "force"
      );
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("deletes an in-project env", async () => {
      mockQuery({ "computerEnvironments:getEnvironment": ENV_ROW });
      mockMutation({ "computerEnvironments:deleteEnvironment": { deleted: true } });
      const res = await request(
        "DELETE",
        "/api/v1/projects/p1/computer-environments/env1"
      );
      expect(res.status).toBe(200);
      expect((await res.json()) as Record<string, unknown>).toMatchObject({
        id: "env1",
        deleted: true,
      });
    });
  });

  describe("build / use / reset", () => {
    it("triggers a build (202) after the scope guard", async () => {
      mockQuery({ "computerEnvironments:getEnvironment": ENV_ROW });
      mockMutation({
        "computerEnvironments:startEnvironmentBuild": {
          buildId: "b2",
          reused: false,
        },
      });
      const res = await request(
        "POST",
        "/api/v1/projects/p1/computer-environments/env1/build"
      );
      expect(res.status).toBe(202);
      expect((await res.json()) as Record<string, unknown>).toMatchObject({
        id: "env1",
        buildId: "b2",
        reused: false,
      });
    });

    it("attaches an env to the computer, forwarding projectId + environmentId", async () => {
      mockQuery({ "computerEnvironments:getEnvironment": ENV_ROW });
      mockMutation({
        "projectComputers:setComputerEnvironment": {
          computerId: "c1",
          status: "provisioning",
        },
      });
      const res = await request(
        "POST",
        "/api/v1/projects/p1/computer-environments/env1/use"
      );
      expect(res.status).toBe(200);
      expect((await res.json()) as Record<string, unknown>).toMatchObject({
        environmentId: "env1",
        computerId: "c1",
        status: "provisioning",
      });
      expect(convexMutationMock).toHaveBeenCalledWith(
        "projectComputers:setComputerEnvironment",
        { projectId: "p1", environmentId: "env1" }
      );
    });

    it("resets the computer, forwarding only projectId", async () => {
      mockMutation({ "projectComputers:resetComputer": { reset: true } });
      const res = await request(
        "POST",
        "/api/v1/projects/p1/computer/reset"
      );
      expect(res.status).toBe(200);
      expect((await res.json()) as Record<string, unknown>).toMatchObject({
        projectId: "p1",
        reset: true,
      });
      expect(convexMutationMock).toHaveBeenCalledWith(
        "projectComputers:resetComputer",
        { projectId: "p1" }
      );
    });
  });
});
