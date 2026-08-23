import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * I1 registry routes: directory proxies, project-scoped reads, install
 * adapters, guest posture, and ConvexError → v1 mapping.
 *
 * These routes stay OUT of openapi-drift PUBLIC_OPERATIONS on purpose:
 * bearer is always required. Anonymous MCP callers arrive with minted guest
 * tokens, not with no token. Guests may hit the three directory reads only.
 */

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
  })),
}));

import v1Routes from "../index.js";
import { isGuestAllowedV1Request } from "../guest-allowed-paths.js";
import { looksLikeConvexId } from "../registry.js";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function request(
  method: string,
  path: string,
  opts: { token?: string; body?: Record<string, unknown> } = {}
): Promise<Response> {
  const token = opts.token ?? "tok";
  return Promise.resolve(
    makeApp().request(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    })
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function convexError(code: string, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error("ConvexError"), {
    data: { code, message, ...extra },
  });
}

function stubDelegatedMint(): void {
  process.env.INSPECTOR_SERVICE_TOKEN = "svc_token";
  validateApiKeyMock.mockResolvedValue({
    apiKey: { id: "key_1", owner: { id: "workos_user_1" } },
  });
  resolveUserByExternalIdMock.mockResolvedValue({ _id: "convex_user_1" });
  lookupWorkosKeyBindingMock.mockResolvedValue({
    mcpjamOrganizationId: "org_a",
  });
}

describe("v1 registry", () => {
  const originalEnv = {
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
    CONVEX_URL: process.env.CONVEX_URL,
    INSPECTOR_SERVICE_TOKEN: process.env.INSPECTOR_SERVICE_TOKEN,
  };
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    process.env.CONVEX_URL = "https://convex.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
  });

  describe("directory read proxies", () => {
    it.each([
      [
        "/api/v1/registry/directory-servers?q=linear&source=all&connectableOnly=true&limit=10",
        "https://convex-http.example.com/v1/registry/directory-servers?q=linear&source=all&connectableOnly=true&limit=10",
      ],
      [
        "/api/v1/registry/directory-sources",
        "https://convex-http.example.com/v1/registry/directory-sources",
      ],
      [
        "/api/v1/projects/p1/registry/servers?scope=all",
        "https://convex-http.example.com/v1/registry/servers?projectId=p1&scope=all",
      ],
      [
        "/api/v1/projects/p1/registry/connections",
        "https://convex-http.example.com/v1/registry/connections?projectId=p1",
      ],
    ])("maps %s onto Convex", async (inspectorPath, convexUrl) => {
      fetchMock.mockResolvedValue(jsonResponse({ items: [] }));
      const res = await request("GET", inspectorPath);
      expect(res.status).toBe(200);
      const [target, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(String(target)).toBe(convexUrl);
      expect((init.headers as Record<string, string>)["Authorization"]).toBe(
        "Bearer tok"
      );
    });

    it("resolves a Convex id path segment to catalogServerId", async () => {
      const id = "k57abcdefghijklmnopqrstuvwxyz012";
      expect(looksLikeConvexId(id)).toBe(true);
      fetchMock.mockResolvedValue(jsonResponse({ id, serverName: "linear" }));
      const res = await request("GET", `/api/v1/registry/directory-servers/${id}`);
      expect(res.status).toBe(200);
      const [target] = fetchMock.mock.calls[0] as [URL];
      expect(String(target)).toBe(
        `https://convex-http.example.com/v1/registry/directory-server?catalogServerId=${id}`
      );
    });

    it("routes a long scraped serverName to name=, not catalogServerId", async () => {
      // 20+ alphanumerics used to satisfy the id heuristic; real Convex ids
      // are lowercase and ~32 chars.
      for (const name of ["supercalifragilistic", "SomeScrapedServer2024Name"]) {
        expect(looksLikeConvexId(name)).toBe(false);
        fetchMock.mockClear();
        fetchMock.mockResolvedValue(jsonResponse({ id: "c1", serverName: name }));
        const res = await request(
          "GET",
          `/api/v1/registry/directory-servers/${name}`
        );
        expect(res.status).toBe(200);
        const [target] = fetchMock.mock.calls[0] as [URL];
        expect(new URL(String(target)).searchParams.get("name")).toBe(name);
      }
    });

    it.each([
      [404, { code: "NOT_FOUND", message: "Catalog server not found" }],
      [400, { code: "VALIDATION_ERROR", message: "Invalid id" }],
    ])(
      "falls back to a name lookup when an id-shaped lookup misses with %d",
      async (missStatus, missBody) => {
        const idShapedName = "k57abcdefghijklmnopqrstuvwxyz012";
        fetchMock
          .mockResolvedValueOnce(jsonResponse(missBody, missStatus))
          .mockResolvedValueOnce(
            jsonResponse({ id: "c1", serverName: idShapedName })
          );
        const res = await request(
          "GET",
          `/api/v1/registry/directory-servers/${idShapedName}`
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: "c1", serverName: idShapedName });
        const [first] = fetchMock.mock.calls[0] as [URL];
        const [second] = fetchMock.mock.calls[1] as [URL];
        expect(new URL(String(first)).searchParams.get("catalogServerId")).toBe(
          idShapedName
        );
        expect(new URL(String(second)).searchParams.get("name")).toBe(
          idShapedName
        );
      }
    );

    it("does not retry by name when the id lookup succeeds", async () => {
      const id = "k57abcdefghijklmnopqrstuvwxyz012";
      fetchMock.mockResolvedValue(jsonResponse({ id, serverName: "linear" }));
      const res = await request("GET", `/api/v1/registry/directory-servers/${id}`);
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("resolves a name path segment to name=", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: "c1", serverName: "linear" }));
      const res = await request("GET", "/api/v1/registry/directory-servers/linear");
      expect(res.status).toBe(200);
      const [target] = fetchMock.mock.calls[0] as [URL];
      expect(String(target)).toBe(
        "https://convex-http.example.com/v1/registry/directory-server?name=linear"
      );
    });

    it("forces name= when source= is present, even for an id-shaped segment", async () => {
      const id = "k57abcdefghijklmnopqrstuvwxyz012";
      fetchMock.mockResolvedValue(jsonResponse({ id, serverName: id }));
      await request(
        "GET",
        `/api/v1/registry/directory-servers/${id}?source=claude`
      );
      const [target] = fetchMock.mock.calls[0] as [URL];
      expect(String(target)).toBe(
        `https://convex-http.example.com/v1/registry/directory-server?name=${id}&source=claude`
      );
    });

    it("does not double-decode a percent-encoded path segment", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: "c1", serverName: "foo%2Fbar" }));
      const res = await request(
        "GET",
        "/api/v1/registry/directory-servers/foo%252Fbar"
      );
      expect(res.status).toBe(200);
      const [target] = fetchMock.mock.calls[0] as [URL];
      expect(new URL(String(target)).searchParams.get("name")).toBe("foo%2Fbar");
    });

    it("does not 500 on a malformed percent sequence in the path", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: "c1", serverName: "foo%bar" }));
      const res = await request(
        "GET",
        "/api/v1/registry/directory-servers/foo%bar"
      );
      expect(res.status).toBe(200);
      const [target] = fetchMock.mock.calls[0] as [URL];
      expect(new URL(String(target)).searchParams.get("name")).toBe("foo%bar");
    });

    it("forwards Convex pagination headers", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-next-cursor": "c1",
            "x-mcpjam-next-cursor": "c1",
            link: '</v1/registry/directory-servers?cursor=c1>; rel="next"',
          },
        })
      );
      const res = await request("GET", "/api/v1/registry/directory-servers?q=linear");
      expect(res.status).toBe(200);
      expect(res.headers.get("x-next-cursor")).toBe("c1");
      expect(res.headers.get("x-mcpjam-next-cursor")).toBe("c1");
      expect(res.headers.get("link")).toContain('rel="next"');
    });

    it("maps an unreachable upstream to 502 SERVER_UNREACHABLE", async () => {
      fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
      const res = await request("GET", "/api/v1/registry/directory-servers");
      expect(res.status).toBe(502);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "SERVER_UNREACHABLE"
      );
    });

    it("maps a non-JSON upstream response to 502 SERVER_UNREACHABLE", async () => {
      fetchMock.mockResolvedValue(
        new Response("<html>oops</html>", { status: 200 })
      );
      const res = await request("GET", "/api/v1/registry/directory-servers");
      expect(res.status).toBe(502);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "SERVER_UNREACHABLE"
      );
    });

    it("maps an upstream timeout to 504 TIMEOUT", async () => {
      const abortError = new Error("aborted");
      abortError.name = "AbortError";
      fetchMock.mockRejectedValue(abortError);
      const res = await request("GET", "/api/v1/registry/directory-servers");
      expect(res.status).toBe(504);
      expect(((await res.json()) as { code?: string }).code).toBe("TIMEOUT");
    });
  });

  describe("guest posture", () => {
    it("allows the three directory reads and denies everything else", () => {
      expect(
        isGuestAllowedV1Request("GET", "/api/v1/registry/directory-servers")
      ).toBe(true);
      expect(
        isGuestAllowedV1Request(
          "GET",
          "/api/v1/registry/directory-servers/linear"
        )
      ).toBe(true);
      expect(
        isGuestAllowedV1Request("GET", "/api/v1/registry/directory-sources")
      ).toBe(true);
      expect(
        isGuestAllowedV1Request("GET", "/api/v1/projects/p1/registry/servers")
      ).toBe(false);
      expect(
        isGuestAllowedV1Request(
          "GET",
          "/api/v1/projects/p1/registry/connections"
        )
      ).toBe(false);
      expect(
        isGuestAllowedV1Request(
          "POST",
          "/api/v1/projects/p1/registry/directory-installs"
        )
      ).toBe(false);
      expect(
        isGuestAllowedV1Request(
          "POST",
          "/api/v1/projects/p1/registry/installs"
        )
      ).toBe(false);
      expect(
        isGuestAllowedV1Request(
          "DELETE",
          "/api/v1/projects/p1/registry/installs/rs1"
        )
      ).toBe(false);
      expect(
        isGuestAllowedV1Request("POST", "/api/v1/registry/directory-servers")
      ).toBe(false);
    });

    it("lets a guest bearer through on directory search", async () => {
      validateGuestTokenMock.mockResolvedValue({
        valid: true,
        guestId: "guest_1",
      });
      fetchMock.mockResolvedValue(jsonResponse({ items: [] }));
      const res = await request("GET", "/api/v1/registry/directory-servers?q=linear", {
        token: "guest-token",
      });
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalled();
    });

    it("denies a guest bearer on registry-server reads and writes", async () => {
      validateGuestTokenMock.mockResolvedValue({
        valid: true,
        guestId: "guest_1",
      });
      const denied = [
        await request("GET", "/api/v1/projects/p1/registry/servers", {
          token: "guest-token",
        }),
        await request("GET", "/api/v1/projects/p1/registry/connections", {
          token: "guest-token",
        }),
        await request("POST", "/api/v1/projects/p1/registry/installs", {
          token: "guest-token",
          body: { registryServerId: "rs1" },
        }),
        await request(
          "POST",
          "/api/v1/projects/p1/registry/directory-installs",
          { token: "guest-token", body: { catalogServerId: "cs1" } }
        ),
        await request("DELETE", "/api/v1/projects/p1/registry/installs/rs1", {
          token: "guest-token",
        }),
      ];
      for (const res of denied) {
        expect(res.status).toBe(401);
        expect(((await res.json()) as { code?: string }).code).toBe(
          "UNAUTHORIZED"
        );
      }
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });

  describe("install adapters", () => {
    it("installs a directory server and returns the mutation result", async () => {
      convexMutationMock.mockResolvedValue({
        serverId: "s1",
        serverName: "linear",
        outcome: "created",
      });
      const res = await request(
        "POST",
        "/api/v1/projects/p1/registry/directory-installs",
        {
          body: {
            catalogServerId: "cs1",
            endpointUrl: "https://mcp.linear.app/mcp",
            expectedContentHash: "hash_1",
          },
        }
      );
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        serverId: "s1",
        serverName: "linear",
        outcome: "created",
      });
      expect(convexMutationMock).toHaveBeenCalledWith(
        "serverCatalogConnect:connectCatalogServer",
        {
          projectId: "p1",
          catalogServerId: "cs1",
          endpointUrl: "https://mcp.linear.app/mcp",
          expectedContentHash: "hash_1",
        }
      );
    });

    it("installs a registry card and returns created|reconnected", async () => {
      convexMutationMock.mockResolvedValue({
        serverId: "s1",
        serverName: "linear",
        outcome: "reconnected",
      });
      const res = await request("POST", "/api/v1/projects/p1/registry/installs", {
        body: { registryServerId: "rs1", expectedUpdatedAt: 1700000000000 },
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        serverId: "s1",
        serverName: "linear",
        outcome: "reconnected",
      });
      expect(convexMutationMock).toHaveBeenCalledWith(
        "registryServers:installRegistryServer",
        {
          projectId: "p1",
          registryServerId: "rs1",
          expectedUpdatedAt: 1700000000000,
        }
      );
    });

    it("maps a stale expectedContentHash to CONFLICT + details.code", async () => {
      convexMutationMock.mockRejectedValue(
        convexError(
          "catalog_server_changed",
          "This catalog entry changed since you last read it.",
          { latestContentHash: "hash_new" }
        )
      );
      const res = await request(
        "POST",
        "/api/v1/projects/p1/registry/directory-installs",
        { body: { catalogServerId: "cs1", expectedContentHash: "hash_old" } }
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        code: "CONFLICT",
        message: "This catalog entry changed since you last read it.",
        details: { code: "catalog_server_changed", latestContentHash: "hash_new" },
      });
    });

    it("maps a stale expectedUpdatedAt to CONFLICT + details.code", async () => {
      convexMutationMock.mockRejectedValue(
        convexError(
          "registry_server_changed",
          "This registry card changed since you last read it.",
          { updatedAt: 2 }
        )
      );
      const res = await request("POST", "/api/v1/projects/p1/registry/installs", {
        body: { registryServerId: "rs1", expectedUpdatedAt: 1 },
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: "CONFLICT",
        details: { code: "registry_server_changed", updatedAt: 2 },
      });
    });

    it("maps already_connected_to_different_endpoint to CONFLICT", async () => {
      convexMutationMock.mockRejectedValue(
        convexError(
          "already_connected_to_different_endpoint",
          "This connector is already connected to a different endpoint here.",
          { connectedUrl: "https://other.example/mcp" }
        )
      );
      const res = await request(
        "POST",
        "/api/v1/projects/p1/registry/directory-installs",
        { body: { catalogServerId: "cs1", endpointUrl: "https://eu.example/mcp" } }
      );
      expect(res.status).toBe(409);
      expect(((await res.json()) as { details?: { code?: string } }).details?.code).toBe(
        "already_connected_to_different_endpoint"
      );
    });

    it("maps endpoint_url_not_allowed to VALIDATION_ERROR", async () => {
      convexMutationMock.mockRejectedValue(
        convexError("endpoint_url_not_allowed", "That URL is not in the options list.")
      );
      const res = await request(
        "POST",
        "/api/v1/projects/p1/registry/directory-installs",
        { body: { catalogServerId: "cs1", endpointUrl: "https://evil.example" } }
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: "VALIDATION_ERROR",
        details: { code: "endpoint_url_not_allowed" },
      });
    });

    it("maps a missing catalog row to NOT_FOUND", async () => {
      convexMutationMock.mockRejectedValue(
        convexError("catalog_server_not_found", "That catalog entry does not exist.")
      );
      const res = await request(
        "POST",
        "/api/v1/projects/p1/registry/directory-installs",
        { body: { catalogServerId: "missing" } }
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        code: "NOT_FOUND",
        details: { code: "catalog_server_not_found" },
      });
    });

    it("maps cross-org mismatch to FORBIDDEN", async () => {
      convexMutationMock.mockRejectedValue(
        convexError(
          "registry_project_org_mismatch",
          "Organization registry servers can only be connected inside their own organization"
        )
      );
      stubDelegatedMint();
      global.fetch = vi.fn(
        async (input) => {
          const url = String(input);
          if (url.includes("/web/delegated-token")) {
            return new Response(
              JSON.stringify({
                ok: true,
                token: "delegated-jwt",
                expiresAt: Date.now() + 2 * 60 * 60 * 1000,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return jsonResponse({ items: [] });
        }
      ) as typeof fetch;
      const res = await request("POST", "/api/v1/projects/p_org_b/registry/installs", {
        token: "sk_live_secret",
        body: { registryServerId: "rs_org_a" },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        code: "FORBIDDEN",
        details: { code: "registry_project_org_mismatch" },
      });
    });

    it("maps a missing registry card on the card shelf to NOT_FOUND", async () => {
      convexMutationMock.mockRejectedValue(
        convexError("registry_server_not_found", "Registry server not found")
      );
      const res = await request("POST", "/api/v1/projects/p1/registry/installs", {
        body: { registryServerId: "directory_id_used_as_card" },
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        code: "NOT_FOUND",
        details: { code: "registry_server_not_found" },
      });
    });

    it.each([
      [
        "POST card install",
        () =>
          request("POST", "/api/v1/projects/p1/registry/installs", {
            body: { registryServerId: "not-an-id" },
          }),
      ],
      [
        "POST directory install",
        () =>
          request("POST", "/api/v1/projects/p1/registry/directory-installs", {
            body: { catalogServerId: "k57directoryidonthecardshelf0012" },
          }),
      ],
      [
        "DELETE uninstall",
        () => request("DELETE", "/api/v1/projects/p1/registry/installs/garbage"),
      ],
    ])(
      "maps a Convex argument-validation rejection to 400, not 500 (%s)",
      async (_label, run) => {
        // The REAL failure shape for a malformed or wrong-shelf id: Convex
        // rejects the arguments before the mutation runs, as a plain Error
        // with no `data.code` — not the structured ConvexError the backend
        // throws for a known-missing row.
        convexMutationMock.mockRejectedValue(
          new Error(
            '[Request ID: req_1] Server Error\n' +
              'ArgumentValidationError: Value does not match validator.\n' +
              'Path: .registryServerId\nValue: "garbage"\n' +
              'Validator: v.id("registryServers")'
          )
        );
        const res = await run();
        expect(res.status).toBe(400);
        const body = (await res.json()) as { code?: string; message?: string };
        expect(body.code).toBe("VALIDATION_ERROR");
        // Convex's prose names functions and echoes arguments — it must not
        // reach the caller.
        expect(body.message).toBe("Invalid identifier in request");
        expect(JSON.stringify(body)).not.toContain("ArgumentValidationError");
        expect(JSON.stringify(body)).not.toContain("Request ID");
      }
    );

    it("maps registry_connection_not_found on uninstall to NOT_FOUND", async () => {
      convexMutationMock.mockRejectedValue(
        convexError(
          "registry_connection_not_found",
          "This registry card is not connected here."
        )
      );
      const res = await request(
        "DELETE",
        "/api/v1/projects/p1/registry/installs/rs1"
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        code: "NOT_FOUND",
        details: { code: "registry_connection_not_found" },
      });
    });

    it("rejects unknown body fields on directory install", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/registry/directory-installs",
        { body: { catalogServerId: "cs1", extra: true } }
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("rejects unknown body fields on card install", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/registry/installs",
        { body: { registryServerId: "rs1", extra: true } }
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("rejects a non-number expectedUpdatedAt on card install", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/registry/installs",
        { body: { registryServerId: "rs1", expectedUpdatedAt: "not-a-number" } }
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it.each([
      ["/api/v1/projects/p1/registry/directory-installs", { catalogServerId: "" }],
      ["/api/v1/projects/p1/registry/directory-installs", { catalogServerId: "   " }],
      [
        "/api/v1/projects/p1/registry/directory-installs",
        { catalogServerId: "cs1", endpointUrl: "" },
      ],
      [
        "/api/v1/projects/p1/registry/directory-installs",
        { catalogServerId: "cs1", expectedContentHash: "" },
      ],
      ["/api/v1/projects/p1/registry/installs", { registryServerId: "" }],
      ["/api/v1/projects/p1/registry/installs", { registryServerId: "   " }],
      [
        "/api/v1/projects/p1/registry/installs",
        { registryServerId: "rs1", expectedUpdatedAt: null },
      ],
    ])("rejects empty or null install fields %j", async (path, body) => {
      const res = await request("POST", path, { body });
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("uninstalls a registry card", async () => {
      convexMutationMock.mockResolvedValue({ deleted: true });
      const res = await request(
        "DELETE",
        "/api/v1/projects/p1/registry/installs/rs1"
      );
      expect(res.status).toBe(200);
      expect(convexMutationMock).toHaveBeenCalledWith(
        "registryServers:disconnectRegistryServer",
        { projectId: "p1", registryServerId: "rs1" }
      );
    });
  });
});
