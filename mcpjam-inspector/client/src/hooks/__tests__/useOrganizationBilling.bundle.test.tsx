import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `useOrganizationBilling` used to open five subscriptions per session, which
// is what pushed prod into its concurrent-query cap. These tests pin the fact
// that it now opens exactly one, and that the values it hands back (including
// the loading flags gates depend on) are unchanged.

const mockState = vi.hoisted(() => ({
  isUserReady: true,
  bundle: undefined as unknown,
  queryCalls: [] as Array<{ name: string; args: unknown }>,
  startPlanChangeAction: vi.fn(),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (name: string, args: unknown) => {
      mockState.queryCalls.push({ name, args });
      return undefined;
    },
    // The bundle is read through `useSoftQuery`, i.e. `useQueries`, which takes
    // no entry at all for a skipped query and hands back a failure as a value.
    useQueries: (queries: Record<string, { query: any; args: unknown }>) =>
      Object.fromEntries(
        Object.entries(queries).map(([key, { query, args }]) => {
          const name = getFunctionName(query);
          mockState.queryCalls.push({ name, args });
          return [
            key,
            name === "billing:getOrganizationBillingBundle"
              ? mockState.bundle
              : undefined,
          ];
        }),
      ),
    useMutation: () => vi.fn(),
    useAction: (name: string) =>
      name === "billing:startOrganizationPlanChange"
        ? mockState.startPlanChangeAction
        : vi.fn(),
  };
});

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => mockState.isUserReady,
}));

vi.mock("@/lib/seat-payment-stripe", () => ({
  confirmSeatPaymentWithStripe: vi.fn(),
}));

import { useOrganizationBilling } from "../useOrganizationBilling";

const LEGACY_QUERY_NAMES = [
  "billing:getOrganizationBillingStatus",
  "billing:getOrganizationEntitlements",
  "billing:getOrganizationPremiumness",
  "billing:getProjectPremiumness",
  "billing:getPlanCatalog",
];

const premiumness = (plan: string) => ({
  plan,
  effectivePlan: plan,
  billingInterval: null,
  source: "free",
  enforcementState: "active",
  decisionRequired: false,
  gates: [],
});

// `startPlanChange` gates on `canCheckoutPlan`, which needs a self-serve entry
// with a price for the interval. Kept realistic so the guard can pass.
const checkoutablePlanCatalog = {
  catalogVersion: "v1",
  currency: "usd",
  plans: {
    free: {},
    team: {
      plan: "team",
      isSelfServe: true,
      prices: { monthly: 4000, yearly: 40000 },
      checkout: { plan: "team", supportedIntervals: ["monthly", "yearly"] },
    },
    enterprise: {},
  },
};

const fullBundle = {
  billingStatus: { organizationId: "org-1", plan: "free" },
  entitlements: { plan: "free", features: {}, limits: {} },
  organizationPremiumness: premiumness("free"),
  projectPremiumness: premiumness("team"),
  planCatalog: checkoutablePlanCatalog,
};

function bundleCalls() {
  return mockState.queryCalls.filter(
    (call) => call.name === "billing:getOrganizationBillingBundle",
  );
}

describe("useOrganizationBilling bundled subscription", () => {
  beforeEach(() => {
    mockState.isUserReady = true;
    mockState.bundle = undefined;
    mockState.queryCalls = [];
    mockState.startPlanChangeAction = vi.fn().mockResolvedValue({ ok: true });
  });

  it("opens one bundle subscription and maps every field from it", () => {
    mockState.bundle = fullBundle;

    const { result } = renderHook(() =>
      useOrganizationBilling("org-1", { projectId: "project-1" }),
    );

    const calls = bundleCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({
      organizationId: "org-1",
      projectId: "project-1",
    });

    // Nothing else may hold a live subscription: the whole non-skipped set is
    // this one call. Catches a regression that adds a sixth query back.
    const liveCalls = mockState.queryCalls.filter(
      (call) => call.args !== "skip",
    );
    expect(liveCalls.map((call) => call.name)).toEqual([
      "billing:getOrganizationBillingBundle",
    ]);

    // And the five it replaced are gone entirely, skipped or not.
    for (const name of LEGACY_QUERY_NAMES) {
      expect(mockState.queryCalls.some((call) => call.name === name)).toBe(
        false,
      );
    }

    expect(result.current.billingStatus).toBe(fullBundle.billingStatus);
    expect(result.current.entitlements).toBe(fullBundle.entitlements);
    expect(result.current.organizationPremiumness).toBe(
      fullBundle.organizationPremiumness,
    );
    expect(result.current.projectPremiumness).toBe(
      fullBundle.projectPremiumness,
    );
    expect(result.current.planCatalog).toBe(fullBundle.planCatalog);

    expect(result.current.isLoadingBilling).toBe(false);
    expect(result.current.isLoadingEntitlements).toBe(false);
    expect(result.current.isLoadingOrganizationPremiumness).toBe(false);
    expect(result.current.isLoadingProjectPremiumness).toBe(false);
    expect(result.current.isLoadingPlanCatalog).toBe(false);
  });

  it("sends no projectId and reports undefined project premiumness without a project", () => {
    mockState.bundle = { ...fullBundle, projectPremiumness: null };

    const { result } = renderHook(() => useOrganizationBilling("org-1"));

    expect(bundleCalls()[0].args).toEqual({ organizationId: "org-1" });
    // The server says null for "not asked"; callers have always seen undefined.
    expect(result.current.projectPremiumness).toBeUndefined();
    expect(result.current.isLoadingProjectPremiumness).toBe(false);
    expect(result.current.organizationPremiumness).toBe(
      fullBundle.organizationPremiumness,
    );
  });

  it("reports every surface as loading while the bundle is in flight", () => {
    mockState.bundle = undefined;

    const { result } = renderHook(() =>
      useOrganizationBilling("org-1", { projectId: "project-1" }),
    );

    expect(result.current.isLoadingBilling).toBe(true);
    expect(result.current.isLoadingEntitlements).toBe(true);
    expect(result.current.isLoadingOrganizationPremiumness).toBe(true);
    expect(result.current.isLoadingProjectPremiumness).toBe(true);
    expect(result.current.isLoadingPlanCatalog).toBe(true);
  });

  // 2026-10-04: the bundle hit Convex's read limit for one organization, and
  // `App` calls this hook on every page, so the thrown error replaced the app.
  it("hands back a failed bundle instead of throwing, settled and empty", () => {
    const failure = new Error(
      "[CONVEX Q(billing:getOrganizationBillingBundle)] Server Error",
    );
    mockState.bundle = failure;

    const { result } = renderHook(() =>
      useOrganizationBilling("org-1", { projectId: "project-1" }),
    );

    expect(result.current.queryError).toBe(failure);
    expect(result.current.billingStatus).toBeUndefined();
    expect(result.current.entitlements).toBeUndefined();
    expect(result.current.organizationPremiumness).toBeUndefined();
    expect(result.current.projectPremiumness).toBeUndefined();
    expect(result.current.planCatalog).toBeUndefined();
    // Settled, not loading: a gate waiting on a read that is not coming back
    // would block its action forever. The backend enforces every cap a plan
    // sets anyway.
    expect(result.current.isLoadingBilling).toBe(false);
    expect(result.current.isLoadingEntitlements).toBe(false);
    expect(result.current.isLoadingOrganizationPremiumness).toBe(false);
    expect(result.current.isLoadingProjectPremiumness).toBe(false);
    expect(result.current.isLoadingPlanCatalog).toBe(false);
  });

  it("skips the bundle until the users row exists, and still reads as loading", () => {
    mockState.isUserReady = false;
    mockState.bundle = fullBundle;

    const { result } = renderHook(() =>
      useOrganizationBilling("org-1", { projectId: "project-1" }),
    );

    expect(bundleCalls()).toHaveLength(0);
    // Gates fail open when they read as settled, so the awaiting-user-row
    // window must stay "loading".
    expect(result.current.isLoadingBilling).toBe(true);
    expect(result.current.isLoadingProjectPremiumness).toBe(true);
  });

  it("skips the bundle when the caller disables billing", () => {
    mockState.bundle = fullBundle;

    const { result } = renderHook(() =>
      useOrganizationBilling("org-1", {
        projectId: "project-1",
        enabled: false,
      }),
    );

    expect(bundleCalls()).toHaveLength(0);
    expect(result.current.isLoadingBilling).toBe(false);
    expect(result.current.isLoadingProjectPremiumness).toBe(false);
  });

  // `startPlanChange` reads the plan catalog to decide whether checkout is on
  // offer. That catalog now arrives on the bundle rather than its own query,
  // so the guard has to see the bundled copy.
  it("lets startPlanChange through using the catalog from the bundle", async () => {
    mockState.bundle = fullBundle;

    const { result } = renderHook(() => useOrganizationBilling("org-1"));

    await result.current.startPlanChange("https://return.example", "team");

    expect(mockState.startPlanChangeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        returnUrl: "https://return.example",
        tier: "team",
        billingInterval: "monthly",
      }),
    );
  });

  it("refuses startPlanChange while the bundle has not arrived", async () => {
    mockState.bundle = undefined;

    const { result } = renderHook(() => useOrganizationBilling("org-1"));

    await expect(
      result.current.startPlanChange("https://return.example", "team"),
    ).rejects.toThrow("not offered to this organization");
    expect(mockState.startPlanChangeAction).not.toHaveBeenCalled();
  });
});
