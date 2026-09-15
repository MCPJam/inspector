import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ member: false, query: vi.fn() }));
vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => state.member,
}));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));
vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    state.query(name, args);
    if (args === "skip") return undefined;
    return name.endsWith("getPlanCatalog")
      ? {
          plans: {
            team: { catalogPlanId: "team", topUp: { centsPerCredit: 0.9 } },
          },
        }
      : { effectivePlan: "team", catalogPlanId: "team" };
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
  expect(state.query).toHaveBeenLastCalledWith(
    "billing:getPlanCatalog",
    "skip",
  );
  state.member = true;
  rerender();
  expect(result.current(preset)?.priceCents).toBe(900);
});
