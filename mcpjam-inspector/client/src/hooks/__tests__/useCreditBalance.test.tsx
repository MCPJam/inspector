import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isOutOfCredits,
  normalizeBalance,
  useCreditBalance,
  useOutOfCredits,
  useOutOfCreditsReason,
} from "@/hooks/useCreditBalance";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";

const mocks = vi.hoisted(() => ({
  convexAuth: {
    isAuthenticated: false,
    isLoading: false,
  },
  workosAuth: {
    user: null as { id: string } | null,
    isLoading: false,
  },
  queryResult: undefined as unknown,
  useQuery: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => mocks.convexAuth,
}));

// The balance is a soft read. Route it through `mocks.useQuery` so the
// assertions keep reading as (name, args), "skip" included.
vi.mock("@/hooks/use-soft-query", () => ({
  useSoftQuery: (name: string, args: unknown) => {
    const result = mocks.useQuery(name, args);
    return result instanceof Error
      ? { data: undefined, error: result }
      : { data: result, error: undefined };
  },
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => mocks.workosAuth,
}));

describe("useCreditBalance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.convexAuth.isAuthenticated = false;
    mocks.convexAuth.isLoading = false;
    mocks.workosAuth.user = null;
    mocks.workosAuth.isLoading = false;
    mocks.queryResult = {
      paidCreditsRemaining: 0,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 65,
      freeDailyResetAt: 1_777_777_777_000,
      freeDailyCreditsRemaining: 7,
      freeDailyCreditsTotal: 20,
      walletLocked: false,
    };
    mocks.useQuery.mockImplementation((_name: unknown, args: unknown) =>
      args === "skip" ? undefined : mocks.queryResult
    );
    localStorage.clear();
    useMCPJamLimitDialogStore.setState({
      authStatus: "loading",
      hasPendingLimit: false,
      outOfCreditsHit: false,
      outOfCreditsOrganizationId: null,
      outOfCreditsDismissed: false,
      outOfCreditsDismissedOrganizationId: null,
      balanceOutByOrganization: {},
      isOpen: false,
      intent: null,
      organizationId: null,
      pendingInput: null,
    });
  });

  it("skips guest Convex identities unless guests are included", () => {
    mocks.convexAuth.isAuthenticated = true;

    const { result } = renderHook(() => useCreditBalance());

    expect(mocks.useQuery).toHaveBeenCalledWith(
      "billing:getCreditBalance",
      "skip"
    );
    expect(result.current.balance).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.hasWorkOsUser).toBe(false);
  });

  it("fetches guest balances when includeGuests is enabled without an org", () => {
    mocks.convexAuth.isAuthenticated = true;

    const { result } = renderHook(() =>
      useCreditBalance({ includeGuests: true })
    );

    expect(mocks.useQuery).toHaveBeenCalledWith("billing:getCreditBalance", {});
    expect(result.current.balance).toEqual({
      platformPaidFallback: false,
      platformFreeBudgetExhausted: false,
      platformFreeBudgetResetAt: null,
      paidCreditsRemaining: 0,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 65,
      freeDailyResetAt: 1_777_777_777_000,
      freeDailyCreditsRemaining: 7,
      freeDailyCreditsTotal: 20,
      walletLocked: false,
      billingModel: "daily",
      monthlyResetAt: null,
      // Backend response omits voiceSecondsRemaining → stays undefined so the
      // mic falls back to the global cap instead of reading as out of budget.
      voiceSecondsRemaining: undefined,
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.hasWorkOsUser).toBe(false);
  });

  it("fetches signed-in org balances without includeGuests", () => {
    mocks.convexAuth.isAuthenticated = true;
    mocks.workosAuth.user = { id: "user_123" };

    const { result } = renderHook(() =>
      useCreditBalance({ organizationId: "org-1" })
    );

    expect(mocks.useQuery).toHaveBeenCalledWith("billing:getCreditBalance", {
      organizationId: "org-1",
    });
    expect(result.current.balance?.freeDailyPercentUsed).toBe(65);
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.hasWorkOsUser).toBe(true);
  });

  // The sidebar and the chat input read this on every page; a failed balance
  // has to leave them rendering, with no balance and no endless skeleton.
  it("reads a failed balance as settled with no balance, without throwing", () => {
    mocks.convexAuth.isAuthenticated = true;
    mocks.workosAuth.user = { id: "user_123" };
    mocks.useQuery.mockImplementation((_name: unknown, args: unknown) =>
      args === "skip"
        ? undefined
        : new Error("[CONVEX Q(billing:getCreditBalance)] Server Error")
    );

    const { result } = renderHook(() =>
      useCreditBalance({ organizationId: "org-1" })
    );

    expect(result.current.balance).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });

  it("skips signed-in fetches until an organization is selected", () => {
    mocks.convexAuth.isAuthenticated = true;
    mocks.workosAuth.user = { id: "user_123" };

    const { result } = renderHook(() => useCreditBalance());

    expect(mocks.useQuery).toHaveBeenCalledWith(
      "billing:getCreditBalance",
      "skip"
    );
    expect(result.current.balance).toBeUndefined();
  });

  it("surfaces the monthly model fields for team orgs", () => {
    mocks.convexAuth.isAuthenticated = true;
    mocks.workosAuth.user = { id: "user_123" };
    mocks.queryResult = {
      billingModel: "monthly_per_seat",
      hasPurchaseHistory: true,
      monthlyAllowanceTotal: 18_000,
      monthlyAllowanceRemaining: 13_950,
      monthlyResetAt: 1_777_777_777_000,
      paidCreditsRemaining: 1_500,
      walletLocked: false,
    };

    const { result } = renderHook(() =>
      useCreditBalance({ organizationId: "org-1" })
    );

    expect(result.current.balance?.billingModel).toBe("monthly_per_seat");
    expect(result.current.balance?.monthlyAllowanceTotal).toBe(18_000);
    expect(result.current.balance?.monthlyAllowanceRemaining).toBe(13_950);
    expect(result.current.balance?.paidCreditsRemaining).toBe(1_500);
    expect(result.current.balance?.monthlyResetAt).toBe(1_777_777_777_000);
  });

  it("defaults billingModel to daily when absent or unrecognized", () => {
    mocks.convexAuth.isAuthenticated = true;
    mocks.workosAuth.user = { id: "user_123" };
    mocks.queryResult = {
      billingModel: "something_new",
      paidCreditsRemaining: 0,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 10,
      freeDailyResetAt: 1,
      freeDailyCreditsRemaining: 1,
      freeDailyCreditsTotal: 20,
      walletLocked: false,
    };

    const { result } = renderHook(() =>
      useCreditBalance({ organizationId: "org-1" })
    );

    expect(result.current.balance?.billingModel).toBe("daily");
    // Monthly numerics stay undefined (not coerced to 0).
    expect(result.current.balance?.monthlyAllowanceTotal).toBeUndefined();
    expect(result.current.balance?.monthlyAllowanceRemaining).toBeUndefined();
  });

  it("treats a recent limit hit as out of credits before the balance query catches up", () => {
    mocks.convexAuth.isAuthenticated = true;
    mocks.workosAuth.user = { id: "user_123" };
    localStorage.setItem("active-organization-id:user_123", "org-1");
    mocks.queryResult = {
      paidCreditsRemaining: 0,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 65,
      freeDailyResetAt: 1_777_777_777_000,
      freeDailyCreditsRemaining: 7,
      freeDailyCreditsTotal: 20,
      walletLocked: false,
    };
    useMCPJamLimitDialogStore.setState({
      outOfCreditsHit: true,
      outOfCreditsOrganizationId: "org-1",
    });

    const { result } = renderHook(() => useOutOfCredits());

    expect(result.current).toBe(true);
  });

  it("does not apply an org-specific limit hit to a different resolved org", () => {
    mocks.convexAuth.isAuthenticated = true;
    mocks.workosAuth.user = { id: "user_123" };
    localStorage.setItem("active-organization-id:user_123", "org-2");
    useMCPJamLimitDialogStore.setState({
      outOfCreditsHit: true,
      outOfCreditsOrganizationId: "org-1",
    });

    const { result } = renderHook(() => useOutOfCredits());

    expect(result.current).toBe(false);
  });

  it("clears the local limit hit once the balance query confirms the org is out", async () => {
    mocks.convexAuth.isAuthenticated = true;
    mocks.workosAuth.user = { id: "user_123" };
    localStorage.setItem("active-organization-id:user_123", "org-1");
    mocks.queryResult = {
      paidCreditsRemaining: 0,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 100,
      freeDailyResetAt: 1_777_777_777_000,
      freeDailyCreditsRemaining: 0,
      freeDailyCreditsTotal: 20,
      walletLocked: false,
    };
    useMCPJamLimitDialogStore.setState({
      outOfCreditsHit: true,
      outOfCreditsOrganizationId: "org-1",
    });

    const { result } = renderHook(() => useOutOfCredits());

    expect(result.current).toBe(true);
    await waitFor(() => {
      expect(useMCPJamLimitDialogStore.getState().outOfCreditsHit).toBe(false);
    });
  });

  it("ends a dismissed dialog only when the balance goes from empty to funded", () => {
    mocks.convexAuth.isAuthenticated = true;
    mocks.workosAuth.user = { id: "user_123" };
    localStorage.setItem("active-organization-id:user_123", "org-1");
    const balance = (freeDailyCreditsRemaining: number) => ({
      paidCreditsRemaining: 0,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 100,
      freeDailyResetAt: 1_777_777_777_000,
      freeDailyCreditsRemaining,
      freeDailyCreditsTotal: 20,
      walletLocked: false,
    });
    useMCPJamLimitDialogStore.setState({
      outOfCreditsDismissed: true,
      outOfCreditsDismissedOrganizationId: "org-1",
    });

    // Funded from the start (credits held by in-flight work): still dismissed.
    mocks.queryResult = balance(5);
    const { rerender } = renderHook(() => useOutOfCredits());
    expect(useMCPJamLimitDialogStore.getState().outOfCreditsDismissed).toBe(
      true
    );

    mocks.queryResult = balance(0);
    rerender();
    expect(useMCPJamLimitDialogStore.getState().outOfCreditsDismissed).toBe(
      true
    );

    mocks.queryResult = balance(20);
    rerender();
    expect(useMCPJamLimitDialogStore.getState().outOfCreditsDismissed).toBe(
      false
    );
  });

  it("ends a dismissal on a fresh view when credits came back while none watched", () => {
    mocks.convexAuth.isAuthenticated = true;
    mocks.workosAuth.user = { id: "user_123" };
    localStorage.setItem("active-organization-id:user_123", "org-1");
    // Last read empty by a view that has since unmounted.
    useMCPJamLimitDialogStore.setState({
      outOfCreditsDismissed: true,
      outOfCreditsDismissedOrganizationId: "org-1",
      balanceOutByOrganization: { "org-1": true },
    });

    renderHook(() => useOutOfCredits());

    expect(useMCPJamLimitDialogStore.getState().outOfCreditsDismissed).toBe(
      false
    );
  });

  it("keeps an organization's dismissal when another, funded one is read", () => {
    mocks.convexAuth.isAuthenticated = true;
    mocks.workosAuth.user = { id: "user_123" };
    localStorage.setItem("active-organization-id:user_123", "org-2");
    useMCPJamLimitDialogStore.setState({
      outOfCreditsDismissed: true,
      outOfCreditsDismissedOrganizationId: "org-1",
      balanceOutByOrganization: { "org-1": true },
    });

    renderHook(() => useOutOfCredits());

    expect(useMCPJamLimitDialogStore.getState()).toMatchObject({
      outOfCreditsDismissed: true,
      balanceOutByOrganization: { "org-1": true, "org-2": false },
    });
  });
});

describe("per-call credit minimum", () => {
  const daily = (fields: Record<string, unknown>) =>
    normalizeBalance({
      billingModel: "daily",
      freeDailyCreditsRemaining: 0,
      paidCreditsRemaining: 0,
      freeDailyResetAt: Date.now() + 3 * 60 * 60 * 1000,
      ...fields,
    });

  it.each([
    [0, 0, true],
    [4, 0, true],
    [24, 24, true],
    [25, 0, false],
    [0, 25, false],
  ])(
    "daily bucket %i and wallet %i below a 25 minimum is out: %s",
    (free, paid, out) => {
      expect(
        isOutOfCredits(
          daily({
            freeDailyCreditsRemaining: free,
            paidCreditsRemaining: paid,
            perCallMinimumCredits: 25,
          }),
        ),
      ).toBe(out);
    },
  );

  it("keeps the nothing-left rule when the backend reports no minimum", () => {
    expect(isOutOfCredits(daily({ freeDailyCreditsRemaining: 4 }))).toBe(
      false,
    );
    expect(isOutOfCredits(daily({}))).toBe(true);
    expect(isOutOfCredits(daily({ freeDailyCreditsRemaining: 0.5 }))).toBe(
      false,
    );
    expect(isOutOfCredits(daily({ paidCreditsRemaining: 0.5 }))).toBe(false);
  });

  it("does not apply the minimum to monthly plans", () => {
    expect(
      isOutOfCredits(
        normalizeBalance({
          billingModel: "monthly_per_seat",
          monthlyAllowanceRemaining: 4,
          paidCreditsRemaining: 0,
          perCallMinimumCredits: 25,
        }),
      ),
    ).toBe(false);
  });

  describe("tooltip", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mocks.convexAuth.isAuthenticated = true;
      mocks.workosAuth.user = { id: "user_123" };
      localStorage.clear();
      localStorage.setItem("active-organization-id:user_123", "org-1");
      useMCPJamLimitDialogStore.setState({
        outOfCreditsHit: false,
        outOfCreditsOrganizationId: null,
        balanceOutByOrganization: {},
      });
      mocks.useQuery.mockImplementation((_name: unknown, args: unknown) =>
        args === "skip" ? undefined : mocks.queryResult,
      );
    });

    it("names the per-call minimum when a few credits are left", () => {
      mocks.queryResult = {
        billingModel: "daily",
        freeDailyCreditsRemaining: 4,
        paidCreditsRemaining: 0,
        freeDailyResetAt: Date.now() + 3 * 60 * 60 * 1000,
        perCallMinimumCredits: 25,
      };
      const { result } = renderHook(() => useOutOfCreditsReason());
      expect(result.current).toMatch(
        /^Not enough MCPJam credits · a model call needs at least 25 · /,
      );
    });

    it("keeps the out-of-credits copy at zero", () => {
      mocks.queryResult = {
        billingModel: "daily",
        freeDailyCreditsRemaining: 0,
        paidCreditsRemaining: 0,
        freeDailyResetAt: Date.now() + 3 * 60 * 60 * 1000,
        perCallMinimumCredits: 25,
      };
      const { result } = renderHook(() => useOutOfCreditsReason());
      expect(result.current).toMatch(/^Out of MCPJam credits · /);
    });

    it("unlocks once the bucket resets above the minimum", () => {
      mocks.queryResult = {
        billingModel: "daily",
        freeDailyCreditsRemaining: 4,
        paidCreditsRemaining: 0,
        freeDailyResetAt: Date.now() + 3 * 60 * 60 * 1000,
        perCallMinimumCredits: 25,
      };
      const { result, rerender } = renderHook(() => useOutOfCreditsReason());
      expect(result.current).not.toBeNull();
      mocks.queryResult = {
        ...(mocks.queryResult as Record<string, unknown>),
        freeDailyCreditsRemaining: 200,
      };
      rerender();
      expect(result.current).toBeNull();
    });
  });
});
