import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  member: false,
  catalogPlanId: "team",
  ready: true,
  error: null as Error | null,
  query: vi.fn(),
}));
vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => state.member,
}));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => state.ready,
}));
vi.mock("convex/react", () => ({
  useQueries: (queries: Record<string, unknown>) => {
    state.query(queries);
    if (!queries.quote) return {};
    if (state.error) return { quote: state.error };
    return {
      quote: {
        catalogPlanId: state.catalogPlanId,
        topUpEligible: true,
        canPurchase: false,
        currency: "usd",
        presets: [
          {
            packageId: "credits_1000",
            credits: 1000,
            priceCents: 900,
            displayCredits: "1,000 credits",
          },
        ],
      },
    };
  },
}));
import { useCreditTopupPricing } from "../useCreditTopupPricing";
it("waits for a member and uses the organization's matching catalog", () => {
  const preset = {
    packageId: "credits_1000",
    priceCents: 1000,
    displayPrice: "$10",
    displayCredits: "1,000 credits",
  };
  const { result, rerender } = renderHook(() =>
    useCreditTopupPricing("org", true),
  );
  expect(result.current(preset)).toBeNull();
  expect(state.query).toHaveBeenLastCalledWith({});
  state.member = true;
  rerender();
  expect(result.current(preset)?.priceCents).toBe(900);
  expect(result.current(preset)?.displayPrice).toBe("$9.00");
  expect(result.current.canPurchase).toBe(false);
  expect(result.current({ ...preset, packageId: "unknown" })).toBeNull();
});

beforeEach(() => {
  state.member = false;
  state.catalogPlanId = "team";
  state.ready = true;
  state.error = null;
  state.query.mockClear();
});
it("contains backend failures and recovers when pricing becomes available", () => {
  state.member = true;
  state.error = new Error(
    "[CONVEX Q(billing:getOrganizationCreditTopupPresets)] Server Error",
  );
  const preset = {
    packageId: "credits_1000",
    priceCents: 1000,
    displayPrice: "$10",
    displayCredits: "1,000 credits",
  };
  const { result, rerender } = renderHook(() =>
    useCreditTopupPricing("org", true),
  );
  expect(result.current.error).toBe(state.error);
  expect(result.current.canPurchase).toBe(false);
  expect(result.current(preset)).toBeNull();
  state.error = null;
  rerender();
  expect(result.current.error).toBeNull();
  expect(result.current(preset)?.priceCents).toBe(900);
});
it.each([
  { member: false, ready: true, enabled: true, organizationId: "org" },
  { member: true, ready: false, enabled: true, organizationId: "org" },
  { member: true, ready: true, enabled: false, organizationId: "org" },
  { member: true, ready: true, enabled: true, organizationId: null },
])("does not subscribe before prerequisites are met: %j", (input) => {
  state.member = input.member;
  state.ready = input.ready;
  const { result } = renderHook(() =>
    useCreditTopupPricing(input.organizationId, input.enabled),
  );
  expect(state.query).toHaveBeenLastCalledWith({});
  expect(result.current.canPurchase).toBe(false);
});

it.each(["free", "free_v1", "pro", "team", "team_v1"])(
  "identifies whether %s requires an upgrade",
  (plan) => {
    state.member = true;
    state.catalogPlanId = plan;
    const { result } = renderHook(() => useCreditTopupPricing("org", true));
    expect(result.current.requiresUpgrade).toBe(
      plan === "free" || plan === "free_v1",
    );
  },
);
