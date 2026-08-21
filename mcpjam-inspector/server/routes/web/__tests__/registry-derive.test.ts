/**
 * POST /api/web/registry/derive.
 *
 * The ORDER is the contract, and it is the only thing here worth a test:
 * authorize against the backend BEFORE anything is dialed. `/api/web/*`
 * bypasses `sessionAuthMiddleware`, so a derive route that probed first and
 * asked later would be an SSRF oracle with a friendly JSON envelope, however
 * well guarded the socket underneath is.
 *
 * The probe is mocked out entirely — its own behaviour is pinned in
 * `services/__tests__/registry-derive.test.ts`. What is asserted here is who
 * gets to reach it, and how each outcome maps onto a status a client can act
 * on (a refusal is a 400 the client must not retry; an unreachable server is a
 * 502 it may).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// `vi.hoisted`: the mock factories below are hoisted above every import, so
// plain `const`s would not exist yet when they run.
const { deriveRegistryEntry, query } = vi.hoisted(() => ({
  deriveRegistryEntry: vi.fn(),
  query: vi.fn(),
}));

vi.mock("../../../services/registry-derive.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../services/registry-derive.js")
  >();
  return { ...actual, deriveRegistryEntry };
});

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query = query;
  },
}));

import registryRoutes from "../registry.js";
import { mapRuntimeError, webError } from "../errors.js";

function createApp() {
  const app = new Hono();
  app.route("/api/web/registry", registryRoutes);
  app.onError((error, c) => {
    const routeError = mapRuntimeError(error);
    return webError(c, routeError.status, routeError.code, routeError.message);
  });
  return app;
}

function postDerive(
  body: Record<string, unknown>,
  headers: Record<string, string> = { authorization: "Bearer token-123" }
) {
  return createApp().request("/api/web/registry/derive", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const BODY = { url: "https://mcp.example.com/mcp", projectId: "project_1" };

const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CONVEX_HTTP_URL = "https://backend.convex.site";
  query.mockResolvedValue({ organizationId: "org_1", canAdd: true });
  deriveRegistryEntry.mockResolvedValue({
    kind: "derived",
    facts: {
      status: "oauth_required",
      serverName: "example-mcp",
      serverVersion: "1.4.2",
      authRequired: true,
      registrationStrategies: ["dcr"],
      endpointUrl: "https://mcp.example.com/mcp",
    },
  });
});

afterEach(() => {
  if (originalConvexHttpUrl === undefined) {
    delete process.env.CONVEX_HTTP_URL;
  } else {
    process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
  }
});

describe("POST /api/web/registry/derive", () => {
  it("returns the derived facts for a member", async () => {
    const response = await postDerive(BODY);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "oauth_required",
      serverName: "example-mcp",
      serverVersion: "1.4.2",
      authRequired: true,
      registrationStrategies: ["dcr"],
    });
    expect(query).toHaveBeenCalledWith(
      "registryServers:getOrgRegistryContext",
      { projectId: "project_1" }
    );
  });

  it("refuses a request with no bearer BEFORE asking the backend anything", async () => {
    const response = await postDerive(BODY, {});

    expect(response.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
    expect(deriveRegistryEntry).not.toHaveBeenCalled();
  });

  it("does not dial anything for a caller who may not add", async () => {
    query.mockResolvedValue({ organizationId: null, canAdd: false });

    const response = await postDerive(BODY);

    expect(response.status).toBe(403);
    expect(deriveRegistryEntry).not.toHaveBeenCalled();
  });

  it("does not dial anything when the backend cannot be reached", async () => {
    query.mockRejectedValue(new Error("connection reset"));

    const response = await postDerive(BODY);

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.message).toBe("Failed to reach the authorization service.");
    expect(JSON.stringify(body)).not.toContain("connection reset");
    expect(deriveRegistryEntry).not.toHaveBeenCalled();
  });

  it("does not dial anything when Convex is not configured", async () => {
    // `convexUrl` is derived from CONVEX_HTTP_URL and falls back to
    // VITE_CONVEX_URL, so "not configured" means neither is set. The point is
    // that the failure lands BEFORE any egress.
    const previousViteConvexUrl = process.env.VITE_CONVEX_URL;
    delete process.env.CONVEX_HTTP_URL;
    delete process.env.VITE_CONVEX_URL;
    try {
      const response = await postDerive(BODY);

      expect(response.status).toBe(500);
      expect(deriveRegistryEntry).not.toHaveBeenCalled();
    } finally {
      if (previousViteConvexUrl === undefined) {
        delete process.env.VITE_CONVEX_URL;
      } else {
        process.env.VITE_CONVEX_URL = previousViteConvexUrl;
      }
    }
  });

  it("does not leak the Convex error text to the caller", async () => {
    query.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.1.2.3:443 backend-abc.convex.cloud")
    );

    const response = await postDerive(BODY);
    const body = await response.json();

    // An internal hop's failure names deployment hosts and addresses. It
    // belongs in the logs, not in a reply to whoever pasted a URL.
    expect(response.status).toBe(502);
    expect(JSON.stringify(body)).not.toMatch(
      /ECONNREFUSED|convex\.cloud|10\.1\.2\.3/
    );
  });

  it("rejects a malformed body before authorizing or dialing", async () => {
    const response = await postDerive({ url: "https://mcp.example.com/mcp" });

    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
    expect(deriveRegistryEntry).not.toHaveBeenCalled();
  });

  it("rejects a URL long enough to be an attack rather than an address", async () => {
    const response = await postDerive({
      ...BODY,
      url: `https://example.com/${"x".repeat(4_000)}`,
    });

    expect(response.status).toBe(400);
    expect(deriveRegistryEntry).not.toHaveBeenCalled();
  });

  it("turns an egress refusal into a 400 with generic copy — never a retryable 5xx", async () => {
    deriveRegistryEntry.mockResolvedValue({ kind: "refused" });

    const response = await postDerive(BODY);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.message).toContain("public internet");
    // The guard's own reason names an address family. It must not travel back
    // to whoever supplied the URL.
    expect(JSON.stringify(body)).not.toMatch(/169\.254|loopback|private/i);
  });

  it("reports a non-MCP answer as 422 and an unreachable server as 502", async () => {
    deriveRegistryEntry.mockResolvedValue({
      kind: "not-mcp",
      detail: "That address answered, but it is not an MCP server.",
    });
    expect((await postDerive(BODY)).status).toBe(422);

    deriveRegistryEntry.mockResolvedValue({
      kind: "unreachable",
      detail: "ETIMEDOUT",
    });
    expect((await postDerive(BODY)).status).toBe(502);
  });
});
