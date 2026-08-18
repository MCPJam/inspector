import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanLimitDialog } from "../PlanLimitDialog";
import { stashUpgradeReturnToken } from "@/hooks/use-upgrade-checkout";
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
  authState,
} = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  trackMock: vi.fn(),
  startMock: vi.fn(),
  upgradeState: {
    currentPlan: "free" as string,
    effectivePlan: "free" as string,
    canManageBilling: true,
    isLoadingPrices: false,
  },
  recipientsState: {
    current: {
      recipients: [] as Array<{ email: string; name?: string | null }>,
      isLoading: false,
    },
  },
  billingState: { plan: "free" as string, isLoading: false },
  authState: { userId: "user-1" as string | null },
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    user: authState.userId ? { id: authState.userId } : null,
    isLoading: false,
  }),
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
      isLoadingPrices: upgradeState.isLoadingPrices,
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
  upgradeState.isLoadingPrices = false;
  recipientsState.current = { recipients: [], isLoading: false };
  billingState.plan = "free";
  billingState.isLoading = false;
  authState.userId = "user-1";
  window.history.replaceState(null, "", "/evals");
  window.sessionStorage.clear();
  usePlanLimitDialogStore.setState({ isOpen: false, limit: null });
});

/**
 * A return is only honored in the tab that started checkout, so the tests have
 * to arrive the way a real user does: with the one-shot token in hand.
 */
function arriveFromCheckout(
  url: string,
  organizationId = "org-1",
  origin: "evals" | "credits" = "evals",
  userId = "user-1"
) {
  stashUpgradeReturnToken(organizationId, origin, userId);
  window.history.replaceState(null, "", url);
}

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
      /The Team plan includes 5,000 per seat each month/
    );
  });

  it("drops the conjunction when the limit carries no reset time", () => {
    openEvalLimit({ resetsAt: null });
    render(<PlanLimitDialog />);

    const description = screen.getByTestId("plan-limit-dialog-description");
    expect(description).toHaveTextContent(/Free includes 75 a day\./);
    expect(description).not.toHaveTextContent(/, and/);
    expect(description).not.toHaveTextContent(/reset at/i);
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

  it("keeps checkout unreachable while the price catalog is still loading", () => {
    upgradeState.isLoadingPrices = true;
    openEvalLimit();
    render(<PlanLimitDialog />);

    // Dialog-level wiring only: the hook's loading flag has to reach the CTA.
    // How the picker disables the interval cards is the picker's business.
    const cta = screen.getByTestId("upgrade-plan-cta");
    expect(cta).toBeDisabled();
    expect(cta).toHaveTextContent(/Loading prices/);
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

  it("closes after an in-place plan change succeeds", async () => {
    const user = userEvent.setup();
    startMock.mockResolvedValue({ redirected: false, shouldDismiss: true });
    openEvalLimit();
    render(<PlanLimitDialog />);

    await user.click(screen.getByTestId("upgrade-plan-cta"));

    expect(usePlanLimitDialogStore.getState().isOpen).toBe(false);
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
    expect(description).not.toHaveTextContent(/The Team plan/);
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
    expect(description).not.toHaveTextContent(/The Team plan/);
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
      arriveFromCheckout(
        "/evals?suite=abc&upgrade=return&upgrade_org=org-1&upgrade_from=evals"
      );
      render(<PlanLimitDialog />);

      await waitFor(() => {
        expect(toastSuccess).toHaveBeenCalledWith(
          expect.stringMatching(/You're on the Team plan/)
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
      arriveFromCheckout(
        "/evals?upgrade=return&upgrade_org=org-1&upgrade_from=evals"
      );
      const view = render(<PlanLimitDialog />);

      // Params are consumed on arrival — the pending outcome lives in state,
      // so a reload or a shared copy of the link can't replay this.
      expect(window.location.search).toBe("");
      expect(toastSuccess).not.toHaveBeenCalled();
      expect(trackMock).not.toHaveBeenCalledWith(
        "plan_limit_upgrade_returned",
        expect.anything()
      );

      billingState.plan = "team";
      view.rerender(<PlanLimitDialog />);
      await waitFor(() => {
        expect(toastSuccess).toHaveBeenCalledWith(
          expect.stringMatching(/You're on the Team plan/)
        );
      });
      expect(window.location.search).toBe("");
    });

    it("stays silent after the settlement window when checkout was abandoned", async () => {
      vi.useFakeTimers();
      try {
        billingState.plan = "free";
        arriveFromCheckout(
          "/evals?upgrade=return&upgrade_org=org-1&upgrade_from=evals"
        );
        render(<PlanLimitDialog />);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });

        expect(trackMock).toHaveBeenCalledWith(
          "plan_limit_upgrade_returned",
          expect.objectContaining({ upgraded: false, settlement: "pending" })
        );
        expect(toastSuccess).not.toHaveBeenCalled();
        expect(window.location.search).toBe("");
      } finally {
        vi.useRealTimers();
      }
    });

    it("still confirms a purchase whose webhook lands after the grace window", async () => {
      vi.useFakeTimers();
      try {
        billingState.plan = "free";
        arriveFromCheckout(
          "/evals?upgrade=return&upgrade_org=org-1&upgrade_from=evals"
        );
        const view = render(<PlanLimitDialog />);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });
        expect(trackMock).toHaveBeenCalledWith(
          "plan_limit_upgrade_returned",
          expect.objectContaining({ upgraded: false, settlement: "pending" })
        );

        // A slow webhook is still a real purchase: the user gets the
        // confirmation they paid for, and the record is corrected.
        billingState.plan = "team";
        view.rerender(<PlanLimitDialog />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });

        expect(toastSuccess).toHaveBeenCalledWith(
          expect.stringMatching(/You're on the Team plan/)
        );
        expect(trackMock).toHaveBeenCalledWith(
          "plan_limit_upgrade_returned",
          expect.objectContaining({ upgraded: true, settlement: "late" })
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("survives the StrictMode double render the app actually mounts under", async () => {
      // main.tsx wraps the tree in StrictMode, which double-invokes render-phase
      // initializers and remounts effects in dev. Claiming the marker twice
      // would burn the one-shot token and swallow the confirmation.
      billingState.plan = "team";
      arriveFromCheckout(
        "/evals?upgrade=return&upgrade_org=org-1&upgrade_from=evals"
      );
      render(
        <StrictMode>
          <PlanLimitDialog />
        </StrictMode>
      );

      await waitFor(() => {
        expect(toastSuccess).toHaveBeenCalledWith(
          expect.stringMatching(/You're on the Team plan/)
        );
      });
    });

    it("still confirms after a reload while the webhook is pending", async () => {
      vi.useFakeTimers();
      try {
        billingState.plan = "free";
        arriveFromCheckout(
          "/evals?upgrade=return&upgrade_org=org-1&upgrade_from=evals"
        );
        const first = render(<PlanLimitDialog />);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });
        expect(toastSuccess).not.toHaveBeenCalled();

        // The user refreshes (or the app remounts) while Stripe's webhook is
        // still in flight. The URL bookkeeping is long gone by now; only the
        // ticket can carry the pending confirmation across.
        first.unmount();
        expect(window.location.search).toBe("");

        billingState.plan = "team";
        render(<PlanLimitDialog />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });

        expect(toastSuccess).toHaveBeenCalledWith(
          expect.stringMatching(/You're on the Team plan/)
        );
        // Reported as late, not immediate: the wait survived the reload.
        expect(trackMock).toHaveBeenCalledWith(
          "plan_limit_upgrade_returned",
          expect.objectContaining({ upgraded: true, settlement: "late" })
        );
        // Retired, so a third load says nothing.
        expect(
          window.sessionStorage.getItem("mcpjam.upgradeReturnToken:user-1")
        ).toBe(null);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not hand the confirmation to whoever signs in next", async () => {
      // sessionStorage survives a sign-out. Without an identity on the ticket,
      // the next person in this tab inherits the toast AND the conversion for
      // a checkout they never started.
      billingState.plan = "team";
      arriveFromCheckout(
        "/evals?upgrade=return&upgrade_org=org-1&upgrade_from=evals",
        "org-1",
        "evals",
        "user-1"
      );

      authState.userId = "user-2";
      render(<PlanLimitDialog />);

      await act(async () => {
        await Promise.resolve();
      });

      expect(toastSuccess).not.toHaveBeenCalled();
      expect(trackMock).not.toHaveBeenCalledWith(
        "plan_limit_upgrade_returned",
        expect.anything()
      );
      // user-2 has no ticket of their own, and user-1's is namespaced out of
      // reach rather than something user-2's session has to notice and clean.
      expect(
        window.sessionStorage.getItem("mcpjam.upgradeReturnToken:user-2")
      ).toBe(null);
    });

    it("disarms a pending confirmation when the buyer signs out mid-flight", async () => {
      // The tab stays mounted across the sign-out, so the flow has to be torn
      // down here — not left pointing at the previous buyer's org for whoever
      // signs in next.
      billingState.plan = "free";
      arriveFromCheckout(
        "/evals?upgrade=return&upgrade_org=org-1&upgrade_from=evals"
      );
      const view = render(<PlanLimitDialog />);
      await act(async () => {
        await Promise.resolve();
      });

      authState.userId = null;
      view.rerender(<PlanLimitDialog />);
      await act(async () => {
        await Promise.resolve();
      });

      // Someone else signs in, and the org they share is already paid.
      authState.userId = "user-2";
      billingState.plan = "team";
      view.rerender(<PlanLimitDialog />);
      await act(async () => {
        await Promise.resolve();
      });

      expect(toastSuccess).not.toHaveBeenCalled();
      expect(trackMock).not.toHaveBeenCalledWith(
        "plan_limit_upgrade_returned",
        expect.anything()
      );
      // user-1's ticket outlives the sign-out untouched — it is namespaced, so
      // user-2's session can neither read nor redeem it — and dies with the tab.
      expect(
        window.sessionStorage.getItem("mcpjam.upgradeReturnToken:user-2")
      ).toBe(null);
    });

    it("does not confirm when sign-out and the paid update land together", async () => {
      // The tightest window: identity drops and billing turns paid on the SAME
      // commit. A passive disarm loses this race — child effects run before
      // parent ones — so the gate has to be synchronous.
      billingState.plan = "free";
      arriveFromCheckout(
        "/evals?upgrade=return&upgrade_org=org-1&upgrade_from=evals"
      );
      const view = render(<PlanLimitDialog />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(toastSuccess).not.toHaveBeenCalled();

      authState.userId = null;
      billingState.plan = "team";
      view.rerender(<PlanLimitDialog />);
      await act(async () => {
        await Promise.resolve();
      });

      expect(toastSuccess).not.toHaveBeenCalled();
      expect(trackMock).not.toHaveBeenCalledWith(
        "plan_limit_upgrade_returned",
        expect.anything()
      );
    });

    it("keeps waiting through a sign-out blip and confirms for the same user", async () => {
      // A token refresh briefly drops the identity. That is not a new user, so
      // the pending confirmation must survive it.
      billingState.plan = "team";
      arriveFromCheckout(
        "/evals?upgrade=return&upgrade_org=org-1&upgrade_from=evals"
      );

      authState.userId = null;
      const view = render(<PlanLimitDialog />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(toastSuccess).not.toHaveBeenCalled();
      expect(
        window.sessionStorage.getItem("mcpjam.upgradeReturnToken:user-1")
      ).not.toBe(null);

      authState.userId = "user-1";
      view.rerender(<PlanLimitDialog />);
      await act(async () => {
        await Promise.resolve();
      });

      expect(toastSuccess).toHaveBeenCalledWith(
        expect.stringMatching(/You're on the Team plan/)
      );
    });

    it("ignores a return marker that did not come from this tab's checkout", async () => {
      // A bookmarked or shared link: no token, so no purchase is announced and
      // no conversion is recorded for a checkout that never happened.
      billingState.plan = "team";
      window.history.replaceState(
        null,
        "",
        "/evals?upgrade=return&upgrade_org=org-1&upgrade_from=evals"
      );
      render(<PlanLimitDialog />);

      await act(async () => {
        await Promise.resolve();
      });

      expect(toastSuccess).not.toHaveBeenCalled();
      expect(trackMock).not.toHaveBeenCalledWith(
        "plan_limit_upgrade_returned",
        expect.anything()
      );
      expect(window.location.search).toBe("");
    });

    it("resolves the org from the ticket, never from the URL", async () => {
      // A tampered or stale `upgrade_org` must not redirect the confirmation:
      // the ticket records the org THIS tab actually started checkout for, and
      // that is the only one we report on.
      billingState.plan = "team";
      arriveFromCheckout(
        "/evals?upgrade=return&upgrade_org=org-2&upgrade_from=evals",
        "org-1"
      );
      render(<PlanLimitDialog />);

      await act(async () => {
        await Promise.resolve();
      });

      expect(trackMock).toHaveBeenCalledWith(
        "plan_limit_upgrade_returned",
        expect.objectContaining({ organization_id: "org-1" })
      );
    });

    it("uses credit wording when the user came from the credits wall", async () => {
      billingState.plan = "team";
      arriveFromCheckout(
        "/chat?upgrade=return&upgrade_org=org-1&upgrade_from=credits",
        "org-1",
        "credits"
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
      arriveFromCheckout("/evals?upgrade=return&upgrade_org=org-1");
      render(<PlanLimitDialog />);

      expect(toastSuccess).not.toHaveBeenCalled();
      expect(trackMock).not.toHaveBeenCalledWith(
        "plan_limit_upgrade_returned",
        expect.anything()
      );
    });
  });
});
