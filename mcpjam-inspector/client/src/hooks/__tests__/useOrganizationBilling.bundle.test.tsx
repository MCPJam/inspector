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
}));

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    mockState.queryCalls.push({ name, args });
    if (args === "skip") return undefined;
    if (name === "billing:getOrganizationBillingBundle")
      return mockState.bundle;
    return undefined;
  },
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
}));

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

const fullBundle = {
  billingStatus: { organizationId: "org-1", plan: "free" },
  entitlements: { plan: "free", features: {}, limits: {} },
  organizationPremiumness: premiumness("free"),
  projectPremiumness: premiumness("team"),
  planCatalog: { catalogVersion: "v1", plans: {} },
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

  it("skips the bundle until the users row exists, and still reads as loading", () => {
    mockState.isUserReady = false;
    mockState.bundle = fullBundle;

    const { result } = renderHook(() =>
      useOrganizationBilling("org-1", { projectId: "project-1" }),
    );

    expect(bundleCalls()[0].args).toBe("skip");
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

    expect(bundleCalls()[0].args).toBe("skip");
    expect(result.current.isLoadingBilling).toBe(false);
    expect(result.current.isLoadingProjectPremiumness).toBe(false);
  });
});
