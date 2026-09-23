import { act, renderHook } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `error` is rendered verbatim in the billing banner, so it must carry the
// shaped copy. A ConvexError's `message` is its serialized payload — the raw
// JSON this state used to hold.

const convexFns = vi.hoisted(() => ({
  startPlanChange: vi.fn(),
  createPortal: vi.fn(),
}));
const billingStatus = vi.hoisted(() => ({ canManageBilling: true }));
const statusQueryError = vi.hoisted(() => ({ current: null as Error | null }));

vi.mock("convex/react", () => ({
  useQueries: (queries: Record<string, unknown>) =>
    queries.status ? { status: statusQueryError.current ?? billingStatus } : {},
  useQuery: (name: string) =>
    name === "billing:getOrganizationBillingStatus" ? billingStatus : undefined,
  useMutation: () => vi.fn(),
  useAction: (name: string) => {
    if (name === "billing:startOrganizationPlanChange")
      return convexFns.startPlanChange;
    if (name === "billing:createOrganizationBillingPortalSession")
      return convexFns.createPortal;
    return vi.fn();
  },
}));

vi.mock("@/lib/pricing-catalog", () => ({ canCheckoutPlan: () => true }));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));

import {
  useCanManageOrganizationBilling,
  useOrganizationBilling,
} from "../useOrganizationBilling";

describe("useOrganizationBilling error state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    billingStatus.canManageBilling = true;
  });

  it("stores the refusal sentence, not the Convex payload, when a plan change is refused", async () => {
    const code = "billing_plan_change_requires_support";
    const message =
      "Moving between a per-seat plan and a flat plan is handled by support.";
    const refusal = new ConvexError({ code, message });
    convexFns.startPlanChange.mockRejectedValue(refusal);

    const { result } = renderHook(() => useOrganizationBilling("org-1"));

    await act(async () => {
      await expect(
        result.current.startPlanChange("https://app.test/billing", "pro"),
      ).rejects.toBe(refusal);
    });

    expect(result.current.error).toBe(message);
    expect(result.current.error).not.toContain(code);
  });

  it("shapes the copy for a member who cannot manage billing", async () => {
    billingStatus.canManageBilling = false;
    convexFns.createPortal.mockRejectedValue(
      new ConvexError({
        code: "billing_feature_not_included",
        feature: "evals",
        plan: "free",
        upgradePlan: "pro",
      }),
    );

    const { result } = renderHook(() => useOrganizationBilling("org-1"));

    await act(async () => {
      await expect(
        result.current.openPortal("https://app.test/billing"),
      ).rejects.toBeInstanceOf(ConvexError);
    });

    expect(result.current.error).toBe(
      "Generate Evals is not included in the Free plan. Ask an organization owner to upgrade to Pro.",
    );
  });
});

describe("useCanManageOrganizationBilling", () => {
  beforeEach(() => {
    billingStatus.canManageBilling = true;
    statusQueryError.current = null;
  });

  it("reads canManageBilling from the billing status", () => {
    const { result } = renderHook(() =>
      useCanManageOrganizationBilling("org-1", true),
    );
    expect(result.current).toBe(true);
  });

  // CreditTopupDialog calls this while open; a throwing query would take the
  // purchase dialog down with it.
  it("returns false instead of throwing when the status query fails", () => {
    statusQueryError.current = new Error("Not a member of this organization");
    const { result } = renderHook(() =>
      useCanManageOrganizationBilling("org-1", true),
    );
    expect(result.current).toBe(false);
  });
});
