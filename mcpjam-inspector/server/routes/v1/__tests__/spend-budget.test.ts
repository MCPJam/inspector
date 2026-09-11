import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * GET / PUT / DELETE /v1/organizations/:organizationId/spend-budget.
 *
 * The UNIT BOUNDARY is what this file covers. The public surface speaks
 * DOLLARS — the unit a buyer budgets in — and the ledger stores whole CREDITS
 * (1 credit = 1c). A conversion that drifted in either direction would
 * silently set a cap a hundred times too large or too small, and nothing
 * downstream would notice: the backend would accept the number and then
 * refuse real work against it.
 *
 * Authorization is deliberately NOT re-implemented here. It belongs to the
 * backend mutation (org admin, guests refused at the boundary); a refusal is
 * translated, never invented.
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
  method: "GET" | "PUT" | "DELETE",
  body?: unknown,
): Promise<Response> {
  return Promise.resolve(
    makeApp().request("/api/v1/organizations/org_a/spend-budget", {
      method,
      headers: {
        Authorization: "Bearer jwt-session-token",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

/** The backend view, exactly as `getOrganizationSpendBudget` returns it. */
function budgetView(overrides: Record<string, unknown> = {}) {
  return {
    capCredits: 5000,
    alertPercents: [80],
    consumedCredits: 4000,
    windowStartAt: 1,
    windowEndsAt: 2,
    alertedPercents: [80],
    capReachedAt: null,
    updatedAt: 3,
    updatedByUserId: "user_1",
    minCapCredits: 100,
    maxCapCredits: 100000000,
    maxAlertCount: 5,
    supported: true,
    ...overrides,
  };
}

describe("/v1/organizations/:organizationId/spend-budget", () => {
  const originalEnv = {
    CONVEX_URL: process.env.CONVEX_URL,
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    convexQueryMock.mockResolvedValue(budgetView());
    convexMutationMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
  });

  it("reports the budget in dollars beside the stored credits", async () => {
    const res = await request("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { capUsd: number; spentUsd: number };
    expect(body.capUsd).toBe(50);
    expect(body.spentUsd).toBe(40);
  });

  it("does not leak the internal actor id into the public DTO", async () => {
    const res = await request("GET");
    const body = (await res.json()) as Record<string, unknown>;
    expect("updatedByUserId" in body).toBe(false);
  });

  it("converts the submitted dollars to whole credits", async () => {
    const res = await request("PUT", { capUsd: 125.5, alertPercents: [50] });
    expect(res.status).toBe(200);
    expect(convexMutationMock).toHaveBeenCalledWith(
      "billing/spendBudgetSettings:setOrganizationSpendBudget",
      expect.objectContaining({ capCredits: 12550, alertPercents: [50] }),
    );
  });

  it("stores the cent the caller wrote, not the float that arrived", async () => {
    // JSON carries money as a float64, so `1.005` reaches the route as
    // 1.00499999999999989 and a plain `Math.round(x * 100)` answers 100 — a
    // cap one cent below what was asked for.
    await request("PUT", { capUsd: 1.005 });
    expect(convexMutationMock).toHaveBeenCalledWith(
      "billing/spendBudgetSettings:setOrganizationSpendBudget",
      expect.objectContaining({ capCredits: 101 }),
    );
  });

  it("leaves a value genuinely below the half cent alone", async () => {
    await request("PUT", { capUsd: 1.0049 });
    expect(convexMutationMock).toHaveBeenCalledWith(
      "billing/spendBudgetSettings:setOrganizationSpendBudget",
      expect.objectContaining({ capCredits: 100 }),
    );
  });

  it("reads back the stored value rather than echoing the request", async () => {
    // A caller whose amount the backend rounded must see what was KEPT.
    convexQueryMock.mockResolvedValue(budgetView({ capCredits: 12550 }));
    const res = await request("PUT", { capUsd: 125.504 });
    const body = (await res.json()) as { capUsd: number };
    expect(body.capUsd).toBe(125.5);
  });

  it("rejects a threshold outside 1..99 before calling the backend", async () => {
    // Reaching the cap always alerts, so accepting 100 here would show the
    // same threshold twice.
    const res = await request("PUT", { capUsd: 50, alertPercents: [100] });
    expect(res.status).toBe(400);
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it("rejects a negative budget", async () => {
    const res = await request("PUT", { capUsd: -1 });
    expect(res.status).toBe(400);
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it("clears the budget on DELETE and reports the org uncapped", async () => {
    convexQueryMock.mockResolvedValue(budgetView({ capCredits: null }));
    const res = await request("DELETE");
    expect(res.status).toBe(200);
    expect(convexMutationMock).toHaveBeenCalledWith(
      "billing/spendBudgetSettings:clearOrganizationSpendBudget",
      expect.objectContaining({ organizationId: "org_a" }),
    );
    const body = (await res.json()) as { capUsd: number | null };
    expect(body.capUsd).toBeNull();
  });
});
