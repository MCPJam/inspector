import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Covers the v1 tunnel surface: create (pre-read → createServerIfMissing →
// grant mint → updateServer), the response whitelist (no secret/secretHash
// passthrough), existed/previous* derivation, and the close proxy that must
// never touch the server record.

const {
  validateGuestTokenMock,
  convexMutationMock,
  validateApiKeyMock,
  resolveUserByExternalIdMock,
  lookupWorkosKeyBindingMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
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
    mutation: convexMutationMock,
    query: vi.fn(),
    action: vi.fn(),
  })),
}));

import v1Routes from "../index.js";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function request(
  app: Hono,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  token = "tok"
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );
}

const GRANT = {
  ok: true,
  slug: "calm-otter",
  url: "https://calm-otter.tunnels.example.com/api/mcp/adapter-http/srv_1?k=plain-secret",
  secret: "plain-secret",
  secretHash: "deadbeef",
  secretVersion: 7,
  connectToken: "ct_abc",
  connectTokenExpiresAt: 1234,
  relayWsUrl: "wss://relay.example.com/agent",
};

type FetchStub = {
  projectServers?: unknown;
  projectServersStatus?: number;
  token?: unknown;
  tokenStatus?: number;
  closeStatus?: number;
};

function stubBackendFetch(stub: FetchStub = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
    const url = String(target);
    if (url.includes("/v1/project-servers")) {
      return Response.json(stub.projectServers ?? { items: [] }, {
        status: stub.projectServersStatus ?? 200,
      });
    }
    if (url.includes("/tunnels/token")) {
      return Response.json(stub.token ?? GRANT, {
        status: stub.tokenStatus ?? 200,
      });
    }
    if (url.includes("/tunnels/close")) {
      return Response.json(
        stub.closeStatus && stub.closeStatus >= 400
          ? { error: "close failed" }
          : { ok: true },
        { status: stub.closeStatus ?? 200 }
      );
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("v1 tunnel routes", () => {
  const originalEnv = {
    CONVEX_URL: process.env.CONVEX_URL,
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
  };
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    convexMutationMock.mockResolvedValue("srv_1");
  });

  afterEach(() => {
    process.env.CONVEX_URL = originalEnv.CONVEX_URL;
    process.env.CONVEX_HTTP_URL = originalEnv.CONVEX_HTTP_URL;
    global.fetch = originalFetch;
  });

  describe("POST /projects/:projectId/tunnels", () => {
    it("creates the server, mints the grant, stores the URL, and whitelists the response", async () => {
      const fetchMock = stubBackendFetch();
      const response = await request(makeApp(), "POST", "/api/v1/projects/p1/tunnels", {
        name: "everything",
      });

      expect(response.status).toBe(201);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toEqual({
        serverId: "srv_1",
        name: "everything",
        existed: false,
        slug: "calm-otter",
        url: GRANT.url,
        connectToken: "ct_abc",
        connectTokenExpiresAt: 1234,
        relayWsUrl: "wss://relay.example.com/agent",
        secretVersion: 7,
      });
      // The plaintext secret and its hash must never pass through.
      expect(body).not.toHaveProperty("secret");
      expect(body).not.toHaveProperty("secretHash");

      // createServerIfMissing then updateServer, with the transport
      // conversion + enable in the update.
      expect(convexMutationMock).toHaveBeenNthCalledWith(
        1,
        "servers:createServerIfMissing",
        { projectId: "p1", name: "everything", enabled: true, transportType: "http" }
      );
      expect(convexMutationMock).toHaveBeenNthCalledWith(
        2,
        "servers:updateServer",
        { serverId: "srv_1", url: GRANT.url, transportType: "http", enabled: true }
      );

      const calls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(calls[0]).toContain("/v1/project-servers?projectId=p1");
      expect(calls[1]).toContain("/tunnels/token?serverId=srv_1&transport=relay");
      const tokenInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
      expect(
        new Headers(tokenInit.headers as HeadersInit).get("authorization")
      ).toBe("Bearer tok");
    });

    it("reports existed + previous config when the name collides", async () => {
      stubBackendFetch({
        projectServers: {
          items: [
            {
              id: "srv_1",
              name: "everything",
              transportType: "stdio",
              url: null,
            },
          ],
        },
      });

      const response = await request(makeApp(), "POST", "/api/v1/projects/p1/tunnels", {
        name: "everything",
      });

      expect(response.status).toBe(201);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.existed).toBe(true);
      expect(body.previousTransportType).toBe("stdio");
      expect(body).not.toHaveProperty("previousUrl");
    });

    it("includes previousUrl when overwriting a differing hand-configured URL", async () => {
      stubBackendFetch({
        projectServers: {
          items: [
            {
              id: "srv_1",
              name: "everything",
              transportType: "http",
              url: "https://hand-configured.example.com/mcp",
            },
          ],
        },
      });

      const response = await request(makeApp(), "POST", "/api/v1/projects/p1/tunnels", {
        name: "everything",
      });

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.existed).toBe(true);
      expect(body.previousUrl).toBe("https://hand-configured.example.com/mcp");
    });

    it("rejects a missing name with the v1 validation envelope", async () => {
      stubBackendFetch();
      const response = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/tunnels",
        {}
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { code?: string };
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("maps grant mint failures to SERVER_UNREACHABLE without storing a URL", async () => {
      stubBackendFetch({
        token: { error: "relay down" },
        tokenStatus: 503,
      });

      const response = await request(makeApp(), "POST", "/api/v1/projects/p1/tunnels", {
        name: "everything",
      });

      expect(response.status).toBe(502);
      const body = (await response.json()) as { code?: string; message?: string };
      expect(body.code).toBe("SERVER_UNREACHABLE");
      expect(body.message).toContain("relay down");
      // createServerIfMissing ran; updateServer must not have.
      expect(convexMutationMock).toHaveBeenCalledTimes(1);
    });

    it("404s the project when the backend pre-read rejects it", async () => {
      stubBackendFetch({
        projectServers: { code: "NOT_FOUND", message: "Project not found" },
        projectServersStatus: 404,
      });

      const response = await request(makeApp(), "POST", "/api/v1/projects/nope/tunnels", {
        name: "everything",
      });

      expect(response.status).toBe(404);
      expect(((await response.json()) as { code?: string }).code).toBe("NOT_FOUND");
    });

    it("fails fast when CONVEX_URL is missing", async () => {
      stubBackendFetch();
      delete process.env.CONVEX_URL;

      const response = await request(makeApp(), "POST", "/api/v1/projects/p1/tunnels", {
        name: "everything",
      });

      expect(response.status).toBe(500);
      const body = (await response.json()) as { message?: string };
      expect(body.message).toContain("CONVEX_URL");
    });

    it("fails fast when CONVEX_HTTP_URL is missing", async () => {
      stubBackendFetch();
      delete process.env.CONVEX_HTTP_URL;

      const response = await request(makeApp(), "POST", "/api/v1/projects/p1/tunnels", {
        name: "everything",
      });

      expect(response.status).toBe(500);
      const body = (await response.json()) as { message?: string };
      expect(body.message).toContain("CONVEX_HTTP_URL");
    });
  });

  describe("POST /projects/:projectId/tunnels/:serverId/close", () => {
    it("forwards to /tunnels/close and never mutates the server record", async () => {
      const fetchMock = stubBackendFetch({
        projectServers: { items: [{ id: "srv_1", name: "everything" }] },
      });

      const response = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/tunnels/srv_1/close"
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ serverId: "srv_1", status: "closed" });
      const closeCall = fetchMock.mock.calls.find((call) =>
        String(call[0]).includes("/tunnels/close")
      );
      expect(closeCall).toBeDefined();
      const init = closeCall?.[1] as RequestInit;
      expect(JSON.parse(String(init.body))).toEqual({ serverId: "srv_1" });
      expect(
        new Headers(init.headers as HeadersInit).get("authorization")
      ).toBe("Bearer tok");
      // The server record stays untouched — closing must not delete or
      // patch anything.
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("404s serverIds outside the project scope", async () => {
      const fetchMock = stubBackendFetch({
        projectServers: { items: [{ id: "srv_other", name: "other" }] },
      });

      const response = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/tunnels/srv_1/close"
      );

      expect(response.status).toBe(404);
      expect(
        fetchMock.mock.calls.some((call) =>
          String(call[0]).includes("/tunnels/close")
        )
      ).toBe(false);
    });

    it("maps backend close failures to SERVER_UNREACHABLE", async () => {
      stubBackendFetch({
        projectServers: { items: [{ id: "srv_1", name: "everything" }] },
        closeStatus: 500,
      });

      const response = await request(
        makeApp(),
        "POST",
        "/api/v1/projects/p1/tunnels/srv_1/close"
      );

      expect(response.status).toBe(502);
      const body = (await response.json()) as { code?: string; message?: string };
      expect(body.code).toBe("SERVER_UNREACHABLE");
      expect(body.message).toContain("close failed");
    });
  });
});
