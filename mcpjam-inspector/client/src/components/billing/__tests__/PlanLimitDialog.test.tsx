import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanLimitDialog } from "../PlanLimitDialog";
import { usePlanLimitDialogStore } from "@/stores/plan-limit-dialog-store";

// Hoisted so the vi.mock factories below (which vitest lifts to the top of the
// file) can reach them.
const {
  toastSuccess,
  trackMock,
  startMock,
  upgradeState,
  billingState,
  recipientsState,
} = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  trackMock: vi.fn(),
  startMock: vi.fn(),
  upgradeState: {
    currentPlan: "free" as string,
    effectivePlan: "free" as string,
    canManageBilling: true,
  },
  recipientsState: {
    current: {
      recipients: [] as Array<{ email: string; name?: string | null }>,
      isLoading: false,
    },
  },
  billingState: { plan: "free" as string, isLoading: false },
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: toastSuccess, error: vi.fn() },
}));

vi.mock("@/lib/analytics", () => ({ track: trackMock }));

vi.mock("@/hooks/use-upgrade-checkout", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/hooks/use-upgrade-checkout")
  >();
  return {
    ...actual,
    useUpgradeCheckout: () => ({
      interval: "annual" as const,
      setInterval: vi.fn(),
      annualPriceLabel: "$30",
      monthlyPriceLabel: "$38",
      annualDiscountPct: 21,
      annualSupported: true,
      monthlySupported: true,
      teamName: "Team",
      teamEvalIterations: 5000,
      currentPlan: upgradeState.currentPlan,
      effectivePlan: upgradeState.effectivePlan,
      organizationName: "Acme Robotics",
      canManageBilling: upgradeState.canManageBilling,
      isLoadingBilling: false,
      isStarting: false,
      start: startMock,
    }),
  };
});

vi.mock("@/hooks/useOrganizationBilling", () => ({
  useOrganizationBilling: () => ({
    billingStatus: billingState.isLoading
      ? undefined
      : { plan: billingState.plan, billingInterval: "annual" },
    planCatalog: { plans: { team: { displayName: "Team" } } },
    isLoadingBilling: billingState.isLoading,
  }),
}));

vi.mock("@/hooks/use-upgrade-request-recipients", () => ({
  useUpgradeRequestRecipients: () => recipientsState.current,
}));

const RESETS_AT = Date.UTC(2026, 7, 11, 4, 0);

function openEvalLimit(overrides: Record<string, unknown> = {}) {
  usePlanLimitDialogStore.setState({
    isOpen: true,
    limit: {
      kind: "evalIterations",
      organizationId: "org-1",
      used: 75,
      allowed: 75,
      resetsAt: RESETS_AT,
      windowKind: "day",
      origin: "evals",
      ...overrides,
    } as never,
  });
}

beforeEach(() => {
  toastSuccess.mockReset();
  trackMock.mockReset();
  startMock.mockReset();
  upgradeState.currentPlan = "free";
  upgradeState.effectivePlan = "free";
  upgradeState.canManageBilling = true;
  recipientsState.current = { recipients: [], isLoading: false };
  billingState.plan = "free";
  billingState.isLoading = false;
  window.history.replaceState(null, "", "/evals");
  usePlanLimitDialogStore.setState({ isOpen: false, limit: null });
});

describe("PlanLimitDialog", () => {
  it("renders nothing while closed", () => {
    const { container } = render(<PlanLimitDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the allowance, the reset time, and the catalog Team figure", () => {
    openEvalLimit();
    render(<PlanLimitDialog />);

    expect(
      screen.getByRole("heading", { name: /out of eval iterations today/i })
    ).toBeInTheDocument();
    const description = screen.getByTestId("plan-limit-dialog-description");
    expect(description).toHaveTextContent(/Free includes 75 a day/);
    expect(description).toHaveTextContent(/yours reset at/i);
    // The Team figure comes from the plan catalog, so it tracks what billing
    // enforces rather than a hardcoded marketing string.
    expect(description).toHaveTextContent(
      /Our Team plan includes 5,000 a month/
    );
  });

  it("reports one rich impression, even when the dialog rerenders", () => {
    openEvalLimit();
    const view = render(<PlanLimitDialog />);

    view.rerender(<PlanLimitDialog />);

    const impressions = trackMock.mock.calls.filter(
      ([event]) => event === "plan_limit_dialog_shown"
    );
    expect(impressions).toHaveLength(1);
    expect(impressions[0]?.[1]).toEqual(
      expect.objectContaining({
        wall_kind: "eval_iterations",
        organization_id: "org-1",
        current_plan: "free",
        effective_plan: "free",
        can_manage_billing: true,
        primary_action: "upgrade",
      })
    );
  });

  it("waits for owner recipients before reporting a request impression", () => {
    upgradeState.canManageBilling = false;
    recipientsState.current = { recipients: [], isLoading: true };
    openEvalLimit();
    const view = render(<PlanLimitDialog />);

    expect(trackMock).not.toHaveBeenCalledWith(
      "plan_limit_dialog_shown",
      expect.anything()
    );

    recipientsState.current = {
      recipients: [{ email: "dana@acme.test", name: "Dana Ruiz" }],
      isLoading: false,
    };
    view.rerender(<PlanLimitDialog />);

    expect(trackMock).toHaveBeenCalledWith(
      "plan_limit_dialog_shown",
      expect.objectContaining({
        primary_action: "request_owner",
        request_recipient_count: 1,
      })
    );
  });

  it("shows both prices at once, no toggle to discover", () => {
    openEvalLimit();
    render(<PlanLimitDialog />);

    const annual = screen.getByTestId("upgrade-interval-annual");
    expect(annual).toHaveTextContent("$30");
    expect(annual).toHaveTextContent("per seat/month");
    expect(annual).toHaveTextContent("Save 21%");
    expect(screen.getByTestId("upgrade-interval-monthly")).toHaveTextContent(
      "$38"
    );
    expect(screen.getByTestId("upgrade-plan-cta")).toHaveTextContent(
      /Upgrade to Team/
    );
  });

  it("selects an interval, then confirms with the upgrade button", async () => {
    const user = userEvent.setup();
    openEvalLimit();
    render(<PlanLimitDialog />);

    // Annual leads, and selecting is separate from confirming: pressing a card
    // must not start checkout on its own.
    expect(screen.getByTestId("upgrade-interval-annual")).toHaveAttribute(
      "aria-checked",
      "true"
    );
    await user.click(screen.getByTestId("upgrade-interval-monthly"));
    expect(startMock).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("upgrade-plan-cta"));
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it("has no wait-for-reset button; the close control is the only dismissal", () => {
    openEvalLimit();
    render(<PlanLimitDialog />);

    expect(
      screen.queryByRole("button", { name: /wait for reset/i })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /close/i })).toBeInTheDocument();
  });

  it("offers an owner email instead of a CTA the server would reject", () => {
    upgradeState.canManageBilling = false;
    recipientsState.current = {
      recipients: [{ email: "dana@acme.test", name: "Dana Ruiz" }],
      isLoading: false,
    };
    openEvalLimit();
    render(<PlanLimitDialog />);

    expect(
      screen.getByTestId("plan-limit-dialog-description")
    ).toHaveTextContent(/Only an owner can upgrade this organization/);
    expect(screen.queryByTestId("upgrade-plan-cta")).not.toBeInTheDocument();

    const mail = screen.getByTestId("request-upgrade-mail");
    const href = decodeURIComponent(mail.getAttribute("href") ?? "");
    expect(href).toContain("mailto:dana@acme.test");
    expect(href).toContain("Acme Robotics");
    expect(href).toContain("Organizations, then Billing");
    // Says what it does. It opens a draft; it does not send anything.
    expect(mail).toHaveTextContent(/Email your plan's owner/);
    expect(screen.getByText(/Opens a draft to Dana Ruiz/)).toBeInTheDocument();
  });

  it("hides the owner email when there is no address to write to", () => {
    upgradeState.canManageBilling = false;
    recipientsState.current = { recipients: [], isLoading: false };
    openEvalLimit();
    render(<PlanLimitDialog />);

    expect(
      screen.queryByTestId("request-upgrade-mail")
    ).not.toBeInTheDocument();
  });

  it("points an org already on Team at Enterprise instead of Team", () => {
    upgradeState.currentPlan = "team";
    upgradeState.effectivePlan = "team";
    openEvalLimit({ allowed: 5000, windowKind: "month" });
    render(<PlanLimitDialog />);

    const description = screen.getByTestId("plan-limit-dialog-description");
    expect(description).toHaveTextContent(/Your plan includes 5,000 a month/);
    expect(description).toHaveTextContent(/Enterprise adds negotiated usage/);
    expect(description).not.toHaveTextContent(/Our Team plan/);
    expect(screen.queryByTestId("upgrade-plan-cta")).not.toBeInTheDocument();
    expect(screen.getByTestId("plan-limit-enterprise-cta")).toHaveTextContent(
      /Request upgrade/
    );
  });

  it("reports the Enterprise CTA click", async () => {
    const user = userEvent.setup();
    upgradeState.currentPlan = "team";
    upgradeState.effectivePlan = "team";
    openEvalLimit({ allowed: 5000, windowKind: "month" });
    render(<PlanLimitDialog />);

    await user.click(screen.getByTestId("plan-limit-enterprise-cta"));
    expect(trackMock).toHaveBeenCalledWith(
      "plan_limit_enterprise_cta_clicked",
      expect.objectContaining({ plan: "team" })
    );
    expect(usePlanLimitDialogStore.getState().isOpen).toBe(false);
  });

  it("offers nothing to pitch when the org is already on Enterprise", () => {
    upgradeState.currentPlan = "enterprise";
    upgradeState.effectivePlan = "enterprise";
    openEvalLimit({ allowed: 50000, windowKind: "month" });
    render(<PlanLimitDialog />);

    const description = screen.getByTestId("plan-limit-dialog-description");
    expect(description).toHaveTextContent(/Your plan includes 50,000 a month/);
    expect(description).not.toHaveTextContent(/Enterprise adds/);
    expect(
      screen.queryByTestId("plan-limit-enterprise-cta")
    ).not.toBeInTheDocument();
  });

  it("routes a capped Team trial to Enterprise instead of Team checkout", () => {
    upgradeState.currentPlan = "free";
    upgradeState.effectivePlan = "team";
    openEvalLimit({ allowed: 5000, windowKind: "month" });
    render(<PlanLimitDialog />);

    const description = screen.getByTestId("plan-limit-dialog-description");
    expect(description).toHaveTextContent(/Your plan includes 5,000 a month/);
    expect(description).toHaveTextContent(/Enterprise adds negotiated usage/);
    expect(description).not.toHaveTextContent(/Our Team plan/);
    expect(screen.queryByTestId("upgrade-plan-cta")).not.toBeInTheDocument();
    expect(screen.getByTestId("plan-limit-enterprise-cta")).toBeInTheDocument();
  });

  it("closes and reports a dismissal", async () => {
    const user = userEvent.setup();
    openEvalLimit();
    render(<PlanLimitDialog />);

    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(usePlanLimitDialogStore.getState().isOpen).toBe(false);
    expect(trackMock).toHaveBeenCalledWith(
      "plan_limit_dialog_dismissed",
      expect.objectContaining({ limit_kind: "evalIterations" })
    );
  });

  describe("checkout return", () => {
    it("confirms in place and strips the return params once the plan is paid", async () => {
      billingState.plan = "team";
      window.history.replaceState(
        null,
        "",
        "/evals?suite=abc&upgrade=return&upgrade_org=org-1&upgrade_from=evals"
      );
      render(<PlanLimitDialog />);

      await waitFor(() => {
        expect(toastSuccess).toHaveBeenCalledWith(
          expect.stringMatching(/You're on our Team plan/)
        );
      });
      // The surface the user was blocked on is preserved; only the upgrade
      // bookkeeping is removed.
      expect(window.location.search).toBe("?suite=abc");
      expect(trackMock).toHaveBeenCalledWith(
        "plan_limit_upgrade_returned",
        expect.objectContaining({ upgraded: true, plan: "team" })
      );
    });

    it("waits for delayed billing state before confirming checkout", async () => {
      billingState.plan = "free";
      window.history.replaceState(
        null,
        "",
        "/evals?upgrade=return&upgrade_org=org-1&upgrade_from=evals"
      );
      const view = render(<PlanLimitDialog />);

      expect(window.location.search).toContain("upgrade=return");
      expect(toastSuccess).not.toHaveBeenCalled();
      expect(trackMock).not.toHaveBeenCalledWith(
        "plan_limit_upgrade_returned",
        expect.anything()
      );

      billingState.plan = "team";
      view.rerender(<PlanLimitDialog />);
      await waitFor(() => {
        expect(toastSuccess).toHaveBeenCalledWith(
          expect.stringMatching(/You're on our Team plan/)
        );
      });
      expect(window.location.search).toBe("");
    });

    it("stays silent after the settlement window when checkout was abandoned", async () => {
      vi.useFakeTimers();
      try {
        billingState.plan = "free";
        window.history.replaceState(
          null,
          "",
          "/evals?upgrade=return&upgrade_org=org-1&upgrade_from=evals"
        );
        render(<PlanLimitDialog />);

        expect(window.location.search).toContain("upgrade=return");
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });

        expect(trackMock).toHaveBeenCalledWith(
          "plan_limit_upgrade_returned",
          expect.objectContaining({ upgraded: false })
        );
        expect(toastSuccess).not.toHaveBeenCalled();
        expect(window.location.search).toBe("");
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses credit wording when the user came from the credits wall", async () => {
      billingState.plan = "team";
      window.history.replaceState(
        null,
        "",
        "/chat?upgrade=return&upgrade_org=org-1&upgrade_from=credits"
      );
      render(<PlanLimitDialog />);

      await waitFor(() => {
        expect(toastSuccess).toHaveBeenCalledWith(
          expect.stringMatching(/Your credits are available now/)
        );
      });
    });

    it("waits for billing status before deciding", () => {
      billingState.isLoading = true;
      window.history.replaceState(
        null,
        "",
        "/evals?upgrade=return&upgrade_org=org-1"
      );
      render(<PlanLimitDialog />);

      expect(toastSuccess).not.toHaveBeenCalled();
      // Params survive so a later render can still resolve the outcome.
      expect(window.location.search).toContain("upgrade=return");
    });
  });
});
