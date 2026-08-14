import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * GET /v1/organizations, and specifically THE CLAMP.
 *
 * The backing Convex query (`organizations:getMyOrganizations`) takes no
 * organization argument — it answers for the acting HUMAN. Every other v1 read
 * is org-scoped by the delegated JWT itself, so this route is the one place
 * where the token's scope is not automatically the answer's scope: an `sk_` key
 * bound to org A, minted by someone who also belongs to org B, would return B
 * too if the handler passed the query result through. That is a cross-tenant
 * leak through a legitimately-issued key, which is why it gets its own file.
 */

const {
  validateGuestTokenMock,
  convexQueryMock,
  validateApiKeyMock,
  resolveUserByExternalIdMock,
  lookupWorkosKeyBindingMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  convexQueryMock: vi.fn(),
  validateApiKeyMock: vi.fn(),
  resolveUserByExternalIdMock: vi.fn(),
  lookupWorkosKeyBindingMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

// WorkOS API-key middleware seams — the `sk_` path only.
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
  })),
}));

import v1Routes from "../index.js";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function request(token: string): Promise<Response> {
  return Promise.resolve(
    makeApp().request("/api/v1/organizations", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    })
  );
}

/**
 * The query's real shape: the browser app shell's payload, billing columns and
 * all. The DTO must drop every one of them — the assertions below check that by
 * exact object equality rather than by naming the fields to omit, so a column
 * added upstream fails the test instead of silently joining the response.
 */
function orgRow(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: id,
    _creationTime: 1,
    name,
    plan: "team",
    myRole: "admin",
    isCreator: false,
    logoUrl: null,
    createdAt: 1700000000000,
    updatedAt: 1700000000001,
    createdBy: "user_1",
    stripeCustomerId: "cus_secret",
    stripeSubscriptionId: "sub_secret",
    stripeSeatQuantity: 12,
    billingInterval: "annual",
    workosOrganizationId: "org_workos_1",
    ...overrides,
  };
}

/** A delegated mint the `sk_` path can complete. */
function stubDelegatedMint(): void {
  process.env.INSPECTOR_SERVICE_TOKEN = "svc_token";
  validateApiKeyMock.mockResolvedValue({
    apiKey: { id: "key_1", owner: { id: "workos_user_1" } },
  });
  resolveUserByExternalIdMock.mockResolvedValue({ _id: "convex_user_1" });
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

describe("GET /v1/organizations", () => {
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
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
  });

  it("clamps an org-scoped API key to its own organization", async () => {
    // The user belongs to A and B. The key is bound to A. B must not appear.
    convexQueryMock.mockResolvedValue([
      orgRow("org_a", "Alpha"),
      orgRow("org_b", "Beta"),
    ]);
    stubDelegatedMint();
    lookupWorkosKeyBindingMock.mockResolvedValue({
      mcpjamOrganizationId: "org_a",
    });

    const res = await request("sk_live_secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((organization) => organization.id)).toEqual(["org_a"]);
  });

  it("returns every organization for a session JWT caller", async () => {
    // A person signed into the app belongs to both and is confined to neither
    // — clamping them would hide the very orgs this endpoint exists to list.
    convexQueryMock.mockResolvedValue([
      orgRow("org_a", "Alpha"),
      orgRow("org_b", "Beta"),
    ]);

    const res = await request("jwt-session-token");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((organization) => organization.id)).toEqual([
      "org_a",
      "org_b",
    ]);
  });

  it("projects only the public DTO fields, dropping billing columns", async () => {
    convexQueryMock.mockResolvedValue([
      orgRow("org_a", "Alpha", { logoUrl: "https://cdn.example.com/a.png" }),
    ]);

    const res = await request("jwt-session-token");
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toEqual({
      id: "org_a",
      name: "Alpha",
      plan: "team",
      myRole: "admin",
      isCreator: false,
      logoUrl: "https://cdn.example.com/a.png",
      createdAt: 1700000000000,
    });
  });

  it("tolerates the signup-window null the query can return", async () => {
    // `getMyOrganizations` is a signupTolerantQuery: it answers null rather
    // than throwing for a user row that has not materialized yet.
    convexQueryMock.mockResolvedValue(null);

    const res = await request("jwt-session-token");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  it("rejects guests (default-deny — no guest-allowed-paths entry)", async () => {
    validateGuestTokenMock.mockResolvedValue({ valid: true, guestId: "guest_1" });
    convexQueryMock.mockResolvedValue([orgRow("org_a", "Alpha")]);

    const res = await request("guest-token");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code?: string }).code).toBe("UNAUTHORIZED");
    // The boundary check rejects before the handler, so nothing is read.
    expect(convexQueryMock).not.toHaveBeenCalled();
  });
});
