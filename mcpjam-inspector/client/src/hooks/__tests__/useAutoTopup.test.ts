import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  member: true,
  ready: true,
  raw: undefined as unknown,
  query: vi.fn(),
  mutation: vi.fn(),
  action: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    mocks.query(name, args);
    return mocks.raw;
  },
  useMutation: (name: string) => (args: unknown) => mocks.mutation(name, args),
  useAction: (name: string) => (args: unknown) => mocks.action(name, args),
}));
vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => mocks.member,
}));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => mocks.ready,
}));
vi.mock("@/hooks/useOrgScopedWrite", () => ({
  useOrgScopedWrite: () => ({ run: (work: () => Promise<unknown>) => work() }),
}));
import { useAutoTopup } from "../useAutoTopup";
describe("automatic refill contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.member = true;
    mocks.ready = true;
    mocks.raw = undefined;
  });
  it("skips guests and unready actors", () => {
    mocks.member = false;
    const { result, rerender } = renderHook(() => useAutoTopup("org"));
    expect(mocks.query).toHaveBeenLastCalledWith(
      "billing/autoTopupPreferences:get",
      "skip",
    );
    expect(result.current.querySkipped).toBe(true);
    mocks.member = true;
    mocks.ready = false;
    rerender();
    expect(mocks.query).toHaveBeenLastCalledWith(
      "billing/autoTopupPreferences:get",
      "skip",
    );
  });
  it("reads the nested view without treating saved preferences as enrollment", () => {
    mocks.raw = {
      preferences: {
        thresholdCredits: 100,
        topupCredits: 1000,
        monthlySpendLimitCents: 2700,
      },
      status: "not_active",
      refillPriceCents: 900,
      revision: 4,
    };
    const { result } = renderHook(() => useAutoTopup("org"));
    expect(result.current.view).toEqual(mocks.raw);
  });
  it("saves cents and disables without clearing preferences", async () => {
    const { result } = renderHook(() => useAutoTopup("org"));
    const preferences = {
      thresholdCredits: 100,
      topupCredits: 1000,
      monthlySpendLimitCents: 2700,
    };
    await result.current.save(preferences);
    expect(mocks.mutation).toHaveBeenLastCalledWith(
      "billing/autoTopupPreferences:set",
      { organizationId: "org", ...preferences },
    );
    await result.current.disable();
    expect(mocks.mutation).toHaveBeenLastCalledWith(
      "billing/autoTopupActivation:disable",
      { organizationId: "org" },
    );
    expect(mocks.action).not.toHaveBeenCalled();
  });
  it("clears saved preferences even when ineligible", async () => {
    mocks.raw = { eligible: false, activationAllowed: false };
    const { result } = renderHook(() => useAutoTopup("org"));
    await result.current.clear();
    expect(mocks.mutation).toHaveBeenLastCalledWith(
      "billing/autoTopupPreferences:clear",
      { organizationId: "org" },
    );
  });
  it("binds consent to the server revision and quote; finish uses setup id", async () => {
    mocks.raw = {
      preferences: {},
      activationAllowed: true,
      eligible: true,
      revision: 4,
      refillPriceCents: 900,
      consentVersion: "auto-topup-v1",
    };
    mocks.action.mockResolvedValue({
      setupIntentId: "seti_1",
      clientSecret: "secret",
    });
    const { result } = renderHook(() => useAutoTopup("org"));
    await expect(result.current.begin()).resolves.toEqual({
      setupIntentId: "seti_1",
      clientSecret: "secret",
    });
    expect(mocks.action).toHaveBeenLastCalledWith(
      "billing/autoTopupActivationNode:begin",
      {
        organizationId: "org",
        consent: true,
        expectedRevision: 4,
        expectedPriceCents: 900,
        consentVersion: "auto-topup-v1",
      },
    );
    await result.current.finish("seti_1");
    expect(mocks.action).toHaveBeenLastCalledWith(
      "billing/autoTopupActivationNode:finish",
      { organizationId: "org", setupIntentId: "seti_1" },
    );
  });
  it("does not begin while the rollout is off or the quote is unavailable", async () => {
    mocks.raw = {
      activationAllowed: false,
      eligible: true,
      preferences: {},
      refillPriceCents: 900,
    };
    const { result } = renderHook(() => useAutoTopup("org"));
    await expect(result.current.begin()).rejects.toThrow();
    expect(mocks.action).not.toHaveBeenCalled();
  });
});
