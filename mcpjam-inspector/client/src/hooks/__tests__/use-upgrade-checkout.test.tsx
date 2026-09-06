import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveUpgradeInterval,
  useUpgradeCheckout,
} from "../use-upgrade-checkout";

const {
  billingState,
  startPlanChange,
  toastError,
  toastInfo,
  toastSuccess,
  trackMock,
} = vi.hoisted(() => ({
  billingState: {
    planCatalog: undefined as unknown,
    isLoadingPlanCatalog: false,
  },
  startPlanChange: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  trackMock: vi.fn(),
}));

vi.mock("@/hooks/useOrganizationBilling", () => ({
  useOrganizationBilling: () => ({
    billingStatus: {
      plan: "free",
      effectivePlan: "free",
      organizationName: "Acme Robotics",
      canManageBilling: true,
    },
    planCatalog: billingState.planCatalog,
    startPlanChange,
    isStartingPlanChange: false,
    isLoadingBilling: false,
    isLoadingPlanCatalog: billingState.isLoadingPlanCatalog,
  }),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: { id: "user-1" }, isLoading: false }),
}));

vi.mock("@/lib/analytics", () => ({ track: trackMock }));
vi.mock("@/lib/toast", () => ({
  toast: { error: toastError, info: toastInfo, success: toastSuccess },
}));

function planCatalog(
  supportedIntervals: Array<"monthly" | "annual"> | null,
  prices: { annual: number | null; monthly: number | null } = {
    annual: 36_000,
    monthly: 3_800,
  }
) {
  return {
    currency: "USD",
    plans: {
      team: {
        displayName: "Team",
        prices,
        limits: { maxEvalIterationsPerMonth: 5_000 },
        checkout: supportedIntervals ? { supportedIntervals } : null,
      },
    },
  };
}

beforeEach(() => {
  billingState.planCatalog = undefined;
  billingState.isLoadingPlanCatalog = false;
  startPlanChange.mockReset();
  startPlanChange.mockResolvedValue({ kind: "updated", subscription: {} });
  toastError.mockReset();
  toastInfo.mockReset();
  toastSuccess.mockReset();
  trackMock.mockReset();
  window.history.replaceState(null, "", "/evals");
});

describe("resolveUpgradeInterval", () => {
  it("keeps a valid choice, otherwise prefers annual and then monthly", () => {
    expect(resolveUpgradeInterval("monthly", true, true)).toBe("monthly");
    expect(resolveUpgradeInterval("monthly", true, false)).toBe("annual");
    expect(resolveUpgradeInterval("annual", false, true)).toBe("monthly");
    expect(resolveUpgradeInterval("annual", false, false)).toBeNull();
  });
});

describe("useUpgradeCheckout", () => {
  it("defaults to annual, then switches to monthly when pricing only supports monthly", async () => {
    const view = renderHook(() =>
      useUpgradeCheckout({
        organizationId: "org-1",
        origin: "evals",
        limitKind: "evalIterations",
      })
    );

    expect(view.result.current.interval).toBe("annual");

    billingState.planCatalog = planCatalog(["monthly"]);
    view.rerender();

    await waitFor(() => {
      expect(view.result.current.interval).toBe("monthly");
    });
    await act(async () => {
      await view.result.current.start();
    });

    expect(startPlanChange).toHaveBeenCalledWith(
      expect.stringContaining("upgrade=return"),
      "team",
      "monthly",
      { confirmPaidPlanChange: false }
    );
    expect(trackMock).toHaveBeenCalledWith(
      "plan_limit_upgrade_clicked",
      expect.objectContaining({ billing_interval: "monthly" })
    );
  });

  it("blocks checkout when the catalog supports no interval", async () => {
    billingState.planCatalog = planCatalog([]);
    const { result } = renderHook(() =>
      useUpgradeCheckout({
        organizationId: "org-1",
        origin: "credits",
        limitKind: "credits",
      })
    );

    await act(async () => {
      await result.current.start();
    });

    expect(startPlanChange).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      "Checkout is not available for this plan right now."
    );
    expect(trackMock).toHaveBeenCalledWith(
      "plan_limit_upgrade_failed",
      expect.objectContaining({ error_kind: "no_supported_interval" })
    );
  });

  it("blocks checkout when the catalog says the plan has no checkout", async () => {
    billingState.planCatalog = planCatalog(null);
    const { result } = renderHook(() =>
      useUpgradeCheckout({
        organizationId: "org-1",
        origin: "credits",
        limitKind: "credits",
      })
    );

    // No interval is offered at all, so the picker renders nothing.
    expect(result.current.annualSupported).toBe(false);
    expect(result.current.monthlySupported).toBe(false);

    await act(async () => {
      await result.current.start();
    });

    expect(startPlanChange).not.toHaveBeenCalled();
    expect(trackMock).toHaveBeenCalledWith(
      "plan_limit_upgrade_failed",
      expect.objectContaining({ error_kind: "no_supported_interval" })
    );
  });

  it("drops a supported interval the catalog never priced", async () => {
    billingState.planCatalog = planCatalog(["monthly", "annual"], {
      annual: null,
      monthly: 3_800,
    });
    const view = renderHook(() =>
      useUpgradeCheckout({
        organizationId: "org-1",
        origin: "evals",
        limitKind: "evalIterations",
      })
    );

    expect(view.result.current.annualSupported).toBe(false);
    expect(view.result.current.annualPriceLabel).toBeNull();
    await waitFor(() => {
      expect(view.result.current.interval).toBe("monthly");
    });

    await act(async () => {
      await view.result.current.start();
    });

    // Checkout can only ever be started on the priced interval.
    expect(startPlanChange).toHaveBeenCalledWith(
      expect.stringContaining("upgrade=return"),
      "team",
      "monthly",
      { confirmPaidPlanChange: false }
    );
  });

  it("holds checkout while the catalog is still loading", async () => {
    billingState.planCatalog = planCatalog(["annual"]);
    billingState.isLoadingPlanCatalog = true;
    const { result } = renderHook(() =>
      useUpgradeCheckout({
        organizationId: "org-1",
        origin: "evals",
        limitKind: "evalIterations",
      })
    );

    expect(result.current.isLoadingPrices).toBe(true);

    let outcome: Awaited<ReturnType<typeof result.current.start>>;
    await act(async () => {
      outcome = await result.current.start();
    });

    expect(outcome!).toEqual({ redirected: false, shouldDismiss: false });
    expect(startPlanChange).not.toHaveBeenCalled();
  });

  it("holds checkout when the catalog resolved without a Team entry", async () => {
    // Distinct from the loading case above: nothing is in flight, there is
    // simply no plan to sell. The `!teamEntry` guard is the one that stops it.
    billingState.planCatalog = undefined;
    billingState.isLoadingPlanCatalog = false;
    const { result } = renderHook(() =>
      useUpgradeCheckout({
        organizationId: "org-1",
        origin: "evals",
        limitKind: "evalIterations",
      })
    );

    let outcome: Awaited<ReturnType<typeof result.current.start>>;
    await act(async () => {
      outcome = await result.current.start();
    });

    expect(outcome!).toEqual({ redirected: false, shouldDismiss: false });
    expect(startPlanChange).not.toHaveBeenCalled();
  });

  it("hands checkout to the browser on desktop instead of navigating in place", async () => {
    // The desktop shell cancels in-app navigation to an external origin, so
    // `location.assign` would leave the dialog stranded behind a page that
    // never moves. Open a real browser tab and release the dialog instead.
    billingState.planCatalog = planCatalog(["annual"]);
    startPlanChange.mockResolvedValue({
      kind: "checkout",
      checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_123",
      subscription: { plan: "team" },
    });
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    (window as { isElectron?: boolean }).isElectron = true;

    try {
      const { result } = renderHook(() =>
        useUpgradeCheckout({
          organizationId: "org-1",
          origin: "evals",
          limitKind: "evalIterations",
        })
      );

      let outcome: Awaited<ReturnType<typeof result.current.start>>;
      await act(async () => {
        outcome = await result.current.start();
      });

      expect(openSpy).toHaveBeenCalledWith(
        "https://checkout.stripe.com/c/pay/cs_test_123",
        "_blank",
        "noopener,noreferrer"
      );
      // The dialog closes here, unlike the same-tab path where the page is
      // already on its way out.
      expect(outcome!).toEqual({ redirected: true, shouldDismiss: true });
      // The return token is only worth writing for a return that can land in
      // this session; checkout finishing in another browser can't use it.
      expect(window.sessionStorage.getItem("mcpjam.upgradeReturnToken")).toBe(
        null
      );
    } finally {
      delete (window as { isElectron?: boolean }).isElectron;
      openSpy.mockRestore();
    }
  });

  it("reports an in-place plan update and tells the dialog to close", async () => {
    billingState.planCatalog = planCatalog(["annual"]);
    startPlanChange.mockResolvedValue({
      kind: "updated",
      subscription: { plan: "team" },
    });
    const { result } = renderHook(() =>
      useUpgradeCheckout({
        organizationId: "org-1",
        origin: "evals",
        limitKind: "evalIterations",
      })
    );

    let outcome: Awaited<ReturnType<typeof result.current.start>>;
    await act(async () => {
      outcome = await result.current.start();
    });

    expect(outcome!).toEqual({ redirected: false, shouldDismiss: true });
    expect(toastSuccess).toHaveBeenCalledWith("Plan updated to Team.");
    expect(trackMock).toHaveBeenCalledWith(
      "plan_limit_upgrade_resolved",
      expect.objectContaining({
        result_kind: "updated",
        resulting_plan: "team",
      })
    );
  });

  it("reports a scheduled plan change and tells the dialog to close", async () => {
    billingState.planCatalog = planCatalog(["annual"]);
    startPlanChange.mockResolvedValue({
      kind: "scheduled",
      subscription: { plan: "team" },
    });
    const { result } = renderHook(() =>
      useUpgradeCheckout({
        organizationId: "org-1",
        origin: "credits",
        limitKind: "credits",
      })
    );

    let outcome: Awaited<ReturnType<typeof result.current.start>>;
    await act(async () => {
      outcome = await result.current.start();
    });

    expect(outcome!).toEqual({ redirected: false, shouldDismiss: true });
    expect(toastSuccess).toHaveBeenCalledWith(
      "Plan change scheduled for renewal."
    );
  });

  it("reports only explicit interval choices, not the automatic fallback", async () => {
    billingState.planCatalog = planCatalog(["monthly"]);
    const view = renderHook(() =>
      useUpgradeCheckout({
        organizationId: "org-1",
        origin: "evals",
        limitKind: "evalIterations",
      })
    );

    await waitFor(() => {
      expect(view.result.current.interval).toBe("monthly");
    });
    expect(trackMock).not.toHaveBeenCalledWith(
      "plan_limit_interval_selected",
      expect.anything()
    );

    act(() => view.result.current.setInterval("monthly"));
    expect(trackMock).toHaveBeenCalledWith(
      "plan_limit_interval_selected",
      expect.objectContaining({
        billing_interval: "monthly",
        organization_id: "org-1",
      })
    );
  });
});
