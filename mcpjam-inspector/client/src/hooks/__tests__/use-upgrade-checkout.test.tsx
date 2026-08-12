import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveUpgradeInterval,
  useUpgradeCheckout,
} from "../use-upgrade-checkout";

const { billingState, startPlanChange, toastError, toastSuccess, trackMock } =
  vi.hoisted(() => ({
    billingState: { planCatalog: undefined as unknown },
    startPlanChange: vi.fn(),
    toastError: vi.fn(),
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
  }),
}));

vi.mock("@/lib/analytics", () => ({ track: trackMock }));
vi.mock("@/lib/toast", () => ({
  toast: { error: toastError, success: toastSuccess },
}));

function planCatalog(supportedIntervals: Array<"monthly" | "annual">) {
  return {
    currency: "USD",
    plans: {
      team: {
        displayName: "Team",
        prices: { annual: 36_000, monthly: 3_800 },
        limits: { maxEvalIterationsPerMonth: 5_000 },
        checkout: { supportedIntervals },
      },
    },
  };
}

beforeEach(() => {
  billingState.planCatalog = undefined;
  startPlanChange.mockReset();
  startPlanChange.mockResolvedValue({ kind: "updated", subscription: {} });
  toastError.mockReset();
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
