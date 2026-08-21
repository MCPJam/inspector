import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  useOrganizationBilling,
  useOrganizationBillingStatus,
} from "@/hooks/useOrganizationBilling";

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
  useAction: () => vi.fn(),
  useMutation: () => vi.fn(),
}));

describe("useOrganizationBillingStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports undefined, not null, while the query is still loading", () => {
    mocks.useQuery.mockReturnValue(undefined);

    const { result } = renderHook(() => useOrganizationBillingStatus("org_1"));

    expect(result.current).toBeUndefined();
  });

  it("returns the backend payload for an allowed org read", () => {
    mocks.useQuery.mockReturnValue({ plan: "team" });

    const { result } = renderHook(() => useOrganizationBillingStatus("org_1"));

    expect(result.current).toEqual({ plan: "team" });
  });

  // A consumer that reads `.plan` off this would crash on a raw null.
  it("folds a denied org read (null) into undefined instead of passing it through", () => {
    mocks.useQuery.mockReturnValue(null);

    const { result } = renderHook(() => useOrganizationBillingStatus("org_1"));

    expect(result.current).toBeUndefined();
  });
});

describe("useOrganizationBilling loading flags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports loading while the queries are in flight", () => {
    mocks.useQuery.mockReturnValue(undefined);

    const { result } = renderHook(() => useOrganizationBilling("org_1"));

    expect(result.current.isLoadingBilling).toBe(true);
    expect(result.current.isLoadingPlanCatalog).toBe(true);
  });

  // The flags gate skeletons in OrganizationBillingSection. Deriving them
  // from the null-folded value would leave a denied org loading forever.
  it("stops reporting loading once a denied org read resolves to null", () => {
    mocks.useQuery.mockReturnValue(null);

    const { result } = renderHook(() => useOrganizationBilling("org_1"));

    expect(result.current.billingStatus).toBeUndefined();
    expect(result.current.isLoadingBilling).toBe(false);
    expect(result.current.isLoadingEntitlements).toBe(false);
    expect(result.current.isLoadingOrganizationPremiumness).toBe(false);
    expect(result.current.isLoadingPlanCatalog).toBe(false);
  });

  // Both falsy org ids skip. Spelled out separately because the gate is a
  // truthiness check, and a null-only guard would let "" through to a query.
  it.each([
    ["null", null],
    ["empty string", ""],
  ])(
    "reports no loading when the org id is %s and queries are skipped",
    (_label, organizationId) => {
      mocks.useQuery.mockReturnValue(undefined);

      const { result } = renderHook(() =>
        useOrganizationBilling(organizationId)
      );

      expect(result.current.isLoadingBilling).toBe(false);
      expect(result.current.isLoadingEntitlements).toBe(false);
      expect(result.current.isLoadingOrganizationPremiumness).toBe(false);
      expect(result.current.isLoadingPlanCatalog).toBe(false);
    }
  );

  // The project-scoped query has its own gate on top of the org one, so its
  // flag needs its own in-flight and denied reads to be pinned at all.
  it("reports loading for project premiumness while its read is in flight", () => {
    mocks.useQuery.mockReturnValue(undefined);

    const { result } = renderHook(() =>
      useOrganizationBilling("org_1", { projectId: "proj_1" })
    );

    expect(result.current.isLoadingProjectPremiumness).toBe(true);
  });

  it("stops reporting project premiumness loading on a denied read", () => {
    mocks.useQuery.mockReturnValue(null);

    const { result } = renderHook(() =>
      useOrganizationBilling("org_1", { projectId: "proj_1" })
    );

    expect(result.current.projectPremiumness).toBeUndefined();
    expect(result.current.isLoadingProjectPremiumness).toBe(false);
  });

  // Without a project there is nothing to load, so the flag must stay down
  // even while the org-scoped reads are still in flight.
  it("never reports project premiumness loading when no project is given", () => {
    mocks.useQuery.mockReturnValue(undefined);

    const { result } = renderHook(() => useOrganizationBilling("org_1"));

    expect(result.current.isLoadingProjectPremiumness).toBe(false);
  });
});
