import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CreditBalanceCard } from "../CreditBalanceCard";

let balanceState:
  | {
      outstandingDeficitCredits?: number;
      rolloverCreditsRemaining?: number;
      topUpEligible?: boolean;
      paidCreditsRemaining: number;
      hasPurchaseHistory: boolean;
      freeDailyPercentUsed: number;
      freeDailyCreditsRemaining: number;
      freeDailyCreditsTotal: number;
      freeDailyResetAt: number;
      walletLocked: boolean;
      billingModel?: "daily" | "monthly_per_seat" | "monthly_flat";
      monthlyAllowanceTotal?: number;
      monthlyAllowanceRemaining?: number;
      monthlyResetAt?: number | null;
    }
  | undefined = undefined;
let isLoadingState = false;
let evalQuotaState:
  | {
      starterRemaining?: number | null;
      used: number;
      allowed: number | null;
      resetsAt: number;
      windowKind: "day" | "month";
    }
  | undefined = undefined;
let evalQuotaLoadingState = false;

vi.mock("@/hooks/useCreditBalance", () => ({
  useCreditBalance: () => ({
    balance: balanceState,
    isLoading: isLoadingState,
  }),
}));

vi.mock("@/hooks/useAutoTopup", () => ({
  useAutoTopup: () => ({
    view: {
      revision: 0,
      preferences: null,
      status: "not_configured",
      eligible: true,
      activationAllowed: false,
      refillPriceCents: null,
      card: null,
      paymentIssue: null,
      monthlySpend: { month: "2026-09", chargedCents: 0, reservedCents: 0 },
    },
    isLoading: false,
    querySkipped: false,
    error: null,
    isSaving: false,
    save: vi.fn(),
    disable: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-eval-iteration-quota", () => ({
  useEvalIterationQuota: ({ enabled = true }: { enabled?: boolean }) => ({
    quota: enabled ? evalQuotaState : undefined,
    isLoading: evalQuotaLoadingState,
    isAtLimit: Boolean(
      evalQuotaState &&
        evalQuotaState.allowed !== null &&
        evalQuotaState.used >= evalQuotaState.allowed,
    ),
  }),
}));

vi.mock("@/components/billing/CreditTopupDialog", () => ({
  CreditTopupDialog: ({ open, source }: { open: boolean; source: string }) =>
    open ? <div data-testid="topup-dialog" data-source={source} /> : null,
}));

// Stub the gated button so existing tests don't need to set up the preset
// query. The button's gating logic is covered by TopupActionButton.test.tsx.
vi.mock("@/components/billing/TopupActionButton", () => ({
  TopupActionButton: ({ onClick }: { onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      Buy credits
    </button>
  ),
}));

// Banner has its own dedicated suite — stub here so we don't have to set up
// the underlying Convex/auth hooks for every CreditBalanceCard test.
vi.mock("@/components/billing/PendingCreditTopupsBanner", () => ({
  PendingCreditTopupsBanner: () => null,
}));

describe("CreditBalanceCard", () => {
  beforeEach(() => {
    balanceState = {
      paidCreditsRemaining: 0,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 0,
      freeDailyCreditsRemaining: 300,
      freeDailyCreditsTotal: 300,
      freeDailyResetAt: Date.now() + 11 * 60 * 60 * 1000,
      walletLocked: false,
    };
    isLoadingState = false;
    evalQuotaState = undefined;
    evalQuotaLoadingState = false;
    window.location.hash = "";
  });

  it.each([500, 0, null])(
    "shows the V2 Free starter balance only when granted (%s)",
    (remaining) => {
      evalQuotaState = {
        starterRemaining: remaining,
        used: 0,
        allowed: null,
        resetsAt: 0,
        windowKind: "day",
      };
      render(<CreditBalanceCard pricingVersion="v2" />);
      expect(
        screen.queryByTestId("usage-eval-iterations"),
      ).not.toBeInTheDocument();
      if (remaining === null) {
        expect(
          screen.queryByText(/Free starter eval iterations:/),
        ).not.toBeInTheDocument();
      } else {
        expect(
          screen.getByText(/Free starter eval iterations:/),
        ).toHaveTextContent(
          `${remaining} remaining · one-time allowance of 500`,
        );
      }
    },
  );

  it.each([5000, 50000])(
    "drains the V2 %i-credit tank while keeping the one-time starter allowance",
    (total) => {
      balanceState = {
        ...balanceState!,
        billingModel: "monthly_flat",
        monthlyAllowanceTotal: total,
        monthlyAllowanceRemaining: total * 0.6,
      };
      evalQuotaState = {
        starterRemaining: 5,
        used: 10,
        allowed: 500,
        resetsAt: 0,
        windowKind: "month",
      };
      const { rerender } = render(<CreditBalanceCard pricingVersion="v2" />);
      expect(
        screen.queryByTestId("usage-eval-iterations"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText(/Free starter eval iterations:/),
      ).toHaveTextContent("5 remaining · one-time allowance of 500");
      expect(screen.queryByTestId("usage-daily")).not.toBeInTheDocument();
      expect(screen.getAllByRole("progressbar")).toHaveLength(1);
      expect(screen.getByRole("progressbar")).toHaveAttribute(
        "aria-valuenow",
        "60",
      );
      expect(screen.getByTestId("usage-monthly")).toHaveTextContent(
        `${(
          total * 0.6
        ).toLocaleString()} / ${total.toLocaleString()} remaining`,
      );
      expect(screen.getByTestId("usage-paid")).toHaveTextContent(
        "Top-up credits",
      );
      expect(screen.getByTestId("usage-paid")).toHaveTextContent(
        "Never expire",
      );
      balanceState = {
        ...balanceState!,
        monthlyAllowanceRemaining: 0,
        paidCreditsRemaining: 1200,
      };
      rerender(<CreditBalanceCard pricingVersion="v2" />);
      expect(screen.getByRole("progressbar")).toHaveAttribute(
        "aria-valuenow",
        "0",
      );
      expect(screen.getByTestId("usage-paid")).toHaveTextContent(
        "1,200 credits",
      );
    },
  );

  it.each([
    [5000, 100],
    [6500, 100],
    [0, 0],
    [-50, 0],
  ])("bounds the credit tank for %i remaining", (remaining, percent) => {
    balanceState = {
      ...balanceState!,
      billingModel: "monthly_flat",
      monthlyAllowanceTotal: 5000,
      monthlyAllowanceRemaining: remaining,
    };
    render(<CreditBalanceCard />);
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      String(percent),
    );
    expect(
      screen
        .getByRole("progressbar")
        .querySelector('[data-slot="progress-indicator"]'),
    ).toHaveStyle({ transform: `translateX(-${100 - percent}%)` });
  });

  it("explains rollover as part of available credits, without an overfull fraction", () => {
    balanceState = {
      ...balanceState!,
      billingModel: "monthly_flat",
      monthlyAllowanceTotal: 5000,
      monthlyAllowanceRemaining: 6000,
      rolloverCreditsRemaining: 1000,
      paidCreditsRemaining: 1500,
    };
    render(<CreditBalanceCard pricingVersion="v2" />);
    expect(screen.getByTestId("usage-monthly")).toHaveTextContent(
      "6,000 credits remaining",
    );
    expect(screen.getByTestId("usage-monthly")).not.toHaveTextContent(
      "6,000 / 5,000",
    );
    expect(screen.getByTestId("usage-rollover")).toHaveTextContent(
      "5,000 monthly credits + 1,000 rollover credits",
    );
    expect(screen.getByTestId("usage-rollover")).toHaveTextContent(
      "Included in your available balance",
    );
    expect(screen.getByTestId("usage-paid")).toHaveTextContent("1,500 credits");
  });

  it("does not flash legacy allowances while V2 balances load", () => {
    balanceState = undefined;
    isLoadingState = true;
    evalQuotaLoadingState = true;
    render(<CreditBalanceCard pricingVersion="v2" />);
    expect(
      screen.queryByText(/free daily|eval iterations/i),
    ).not.toBeInTheDocument();
  });

  it("shows debt and carried credits separately from available credits", () => {
    balanceState = {
      ...balanceState!,
      billingModel: "monthly_flat",
      monthlyAllowanceTotal: 5000,
      monthlyAllowanceRemaining: 5700,
      outstandingDeficitCredits: 125,
      rolloverCreditsRemaining: 700,
    };
    render(<CreditBalanceCard />);
    expect(screen.getByTestId("usage-debt")).toHaveTextContent("125 credits");
    expect(screen.getByTestId("usage-rollover")).toHaveTextContent(
      "700 rollover credits",
    );
  });
  it("hides purchase controls for an ineligible Free wallet, including deep links", () => {
    balanceState = { ...balanceState!, topUpEligible: false };
    window.history.replaceState({}, "", "/?topup=open");
    render(<CreditBalanceCard organizationId="org-1" canManageCredits />);
    expect(
      screen.queryByRole("button", { name: "Buy credits" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Auto-reload" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("topup-dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Compare plans for more monthly credits and top-ups" }),
    ).toHaveAttribute("href", "/organizations/org-1/plans");
    window.history.replaceState({}, "", "/");
  });

  it("does not prescribe an upgrade to a locked wallet", () => {
    balanceState = {
      ...balanceState!,
      topUpEligible: false,
      walletLocked: true,
    };
    render(<CreditBalanceCard organizationId="org-1" canManageCredits />);
    expect(
      screen.queryByText("Compare plans for more monthly credits and top-ups"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("usage-wallet-locked")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Buy credits" }),
    ).not.toBeInTheDocument();
  });
  it("keeps eligible Pro purchase controls available", () => {
    balanceState = {
      ...balanceState!,
      topUpEligible: true,
      billingModel: "monthly_flat",
    };
    render(<CreditBalanceCard canManageCredits />);
    expect(
      screen.getByRole("button", { name: "Buy credits" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Auto-reload" }),
    ).toBeInTheDocument();
  });
  it("omits absent or zero debt and rollover", () => {
    balanceState = {
      ...balanceState!,
      outstandingDeficitCredits: 0,
      rolloverCreditsRemaining: 0,
    };
    render(<CreditBalanceCard />);
    expect(screen.queryByTestId("usage-debt")).not.toBeInTheDocument();
    expect(screen.queryByTestId("usage-rollover")).not.toBeInTheDocument();
  });

  it("waits for eligibility before opening a top-up deep link", () => {
    balanceState = undefined;
    isLoadingState = true;
    window.history.replaceState({}, "", "/?topup=open");
    const { rerender } = render(
      <CreditBalanceCard organizationId="org-1" canManageCredits />,
    );
    expect(screen.queryByTestId("topup-dialog")).not.toBeInTheDocument();
    balanceState = {
      paidCreditsRemaining: 0,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 0,
      freeDailyCreditsRemaining: 10,
      freeDailyCreditsTotal: 10,
      freeDailyResetAt: 0,
      walletLocked: false,
      topUpEligible: false,
    };
    isLoadingState = false;
    rerender(<CreditBalanceCard organizationId="org-1" canManageCredits />);
    expect(screen.queryByTestId("topup-dialog")).not.toBeInTheDocument();
    window.history.replaceState({}, "", "/");
  });

  it("uses a plan-neutral label for flat monthly credits", () => {
    balanceState = {
      ...balanceState!,
      billingModel: "monthly_flat",
      monthlyAllowanceTotal: 5000,
      monthlyAllowanceRemaining: 4000,
    };
    render(<CreditBalanceCard organizationId="org-1" />);
    expect(
      screen.getByLabelText("Monthly credits remaining"),
    ).toBeInTheDocument();
  });
  it("opens enrollment from Auto-reload beneath the balance", async () => {
    const user = userEvent.setup();
    render(<CreditBalanceCard canManageCredits />);
    expect(
      screen.getByRole("region", { name: "Buy Credits" }),
    ).toContainElement(screen.getByRole("button", { name: "Buy credits" }));
    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Minimum balance");
  });

  it("lets members review auto-reload without buying credits", async () => {
    const user = userEvent.setup();
    render(<CreditBalanceCard />);
    expect(
      screen.queryByRole("button", { name: "Buy credits" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(
      screen.getByLabelText("Maximum monthly spend (USD, optional)"),
    ).toBeDisabled();
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Ask an organization admin",
    );
  });

  it("renders a skeleton state while balance is loading", () => {
    isLoadingState = true;
    balanceState = undefined;
    render(<CreditBalanceCard />);

    const dailyRow = screen.getByTestId("usage-daily");
    expect(dailyRow).toBeInTheDocument();
    expect(screen.queryByTestId("usage-paid")).not.toBeInTheDocument();
  });

  it("renders the daily-limit row without surfacing any dollar value", () => {
    balanceState = {
      paidCreditsRemaining: 0,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 9,
      freeDailyCreditsRemaining: 273,
      freeDailyCreditsTotal: 300,
      freeDailyResetAt: Date.now() + 11 * 60 * 60 * 1000,
      walletLocked: false,
    };
    render(<CreditBalanceCard />);

    const dailyRow = screen.getByTestId("usage-daily");
    expect(dailyRow).toHaveTextContent(/273 \/ 300/);
    expect(dailyRow).toHaveTextContent(/resets/);
    // Regression guard: free credit dollar value must never appear.
    expect(dailyRow.textContent ?? "").not.toMatch(/\$/);
  });

  it("hides the paid-credits row when the user has never topped up", () => {
    render(<CreditBalanceCard />);
    expect(screen.queryByTestId("usage-paid")).not.toBeInTheDocument();
  });

  it("renders the paid-credits row as org credits, with no dollar value", () => {
    balanceState = {
      paidCreditsRemaining: 1200,
      hasPurchaseHistory: true,
      freeDailyPercentUsed: 100,
      freeDailyCreditsRemaining: 0,
      freeDailyCreditsTotal: 300,
      freeDailyResetAt: Date.now() + 60 * 60 * 1000,
      walletLocked: false,
    };
    render(<CreditBalanceCard />);

    const paidRow = screen.getByTestId("usage-paid");
    expect(paidRow).toHaveTextContent(/Shared paid credits/);
    expect(paidRow).toHaveTextContent(/1,200 credits/);
    // Regression guard: the paid-credits row must NEVER surface a dollar
    // amount. Credits are the user-facing unit; internal pricing/margin math
    // stays off the wire.
    expect(paidRow.textContent ?? "").not.toMatch(/\$/);
  });

  it("shows the org wallet lock state independent of the paid-credits row", () => {
    balanceState = {
      paidCreditsRemaining: 0,
      hasPurchaseHistory: true,
      freeDailyPercentUsed: 0,
      freeDailyCreditsRemaining: 300,
      freeDailyCreditsTotal: 300,
      freeDailyResetAt: Date.now() + 60 * 60 * 1000,
      walletLocked: true,
    };
    render(<CreditBalanceCard />);

    const paidRow = screen.getByTestId("usage-paid");
    expect(paidRow).toHaveTextContent(/0 credits/);
    // The lock notice lives in its own block, not inside the paid row.
    expect(screen.getByTestId("usage-wallet-locked")).toHaveTextContent(
      /paused pending review/,
    );
  });

  it("surfaces the wallet lock notice even with no purchase history", () => {
    // A wallet can be locked (chargeback/dispute) before/without any completed
    // purchase. Gating the notice on purchase history would hide it exactly
    // when the user needs to know spending is paused.
    balanceState = {
      paidCreditsRemaining: 0,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 0,
      freeDailyCreditsRemaining: 300,
      freeDailyCreditsTotal: 300,
      freeDailyResetAt: Date.now() + 60 * 60 * 1000,
      walletLocked: true,
    };
    render(<CreditBalanceCard />);

    expect(screen.queryByTestId("usage-paid")).toBeNull();
    expect(screen.getByTestId("usage-wallet-locked")).toHaveTextContent(
      /paused pending review/,
    );
  });

  it("does NOT expose a tooltip trigger on the daily-limit row (no ambiguity to explain there)", () => {
    render(<CreditBalanceCard />);
    const dailyRow = screen.getByTestId("usage-daily");
    expect(
      within(dailyRow).queryByRole("button", { name: /About/i }),
    ).not.toBeInTheDocument();
  });

  it("renders eval iteration usage in the admin usage card", () => {
    evalQuotaState = {
      used: 7_580,
      allowed: 10_000,
      resetsAt: Date.UTC(2026, 5, 23),
      windowKind: "month",
    };

    render(<CreditBalanceCard organizationId="org-1" />);

    const evalRow = screen.getByTestId("usage-eval-iterations");
    expect(evalRow).toHaveTextContent(/Monthly eval iterations/);
    // Remaining / allowed — 10,000 allowed minus 7,580 used.
    expect(evalRow).toHaveTextContent(/2,420 \/ 10,000/);
    expect(evalRow).not.toHaveTextContent(/Resets/);
  });

  it("shows eval iteration reset time only from the info tooltip", async () => {
    const user = userEvent.setup();
    evalQuotaState = {
      used: 7_580,
      allowed: 10_000,
      resetsAt: Date.UTC(2026, 5, 23),
      windowKind: "month",
    };

    render(<CreditBalanceCard organizationId="org-1" />);

    expect(screen.queryByText(/^Resets /)).not.toBeInTheDocument();

    await user.hover(
      within(screen.getByTestId("usage-eval-iterations")).getByRole("button", {
        name: /About Monthly eval iterations/,
      }),
    );

    expect((await screen.findAllByText(/^Resets /)).length).toBeGreaterThan(0);
  });

  it("hides eval iteration usage for unlimited quotas", () => {
    evalQuotaState = {
      used: 0,
      allowed: null,
      resetsAt: Date.UTC(2026, 5, 23),
      windowKind: "month",
    };

    render(<CreditBalanceCard organizationId="org-1" />);

    expect(
      screen.queryByTestId("usage-eval-iterations"),
    ).not.toBeInTheDocument();
  });

  it("shows an ask-admin hint instead of the Buy credits button for non-managers", () => {
    render(<CreditBalanceCard organizationId="org-1" />);

    expect(
      screen.queryByRole("button", { name: /Buy credits/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("usage-ask-admin")).toHaveTextContent(
      /Ask an owner or admin to add credits/,
    );
  });

  it("opens the top-up dialog when the Top up button is clicked", async () => {
    const user = userEvent.setup();
    render(<CreditBalanceCard organizationId="org-1" canManageCredits />);

    expect(screen.queryByTestId("topup-dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Buy credits/i }));
    const dialog = screen.getByTestId("topup-dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog.getAttribute("data-source")).toBe("billing_page");
  });

  it("auto-opens the top-up dialog with limit_modal source when the topup query flag is present", () => {
    window.history.replaceState(
      {},
      "",
      "/organizations/org-1/billing?topup=open",
    );
    render(<CreditBalanceCard organizationId="org-1" canManageCredits />);

    const dialog = screen.getByTestId("topup-dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog.getAttribute("data-source")).toBe("limit_modal");
    // The flag should be consumed so a reload doesn't reopen the dialog.
    expect(window.location.pathname).toBe("/organizations/org-1/billing");
    expect(window.location.search).toBe("");
  });

  it("does not auto-open when the topup query flag is absent", () => {
    window.history.replaceState({}, "", "/organizations/org-1/billing");
    render(<CreditBalanceCard />);

    expect(screen.queryByTestId("topup-dialog")).not.toBeInTheDocument();
  });

  it("clarifies that credits are organization-scoped", () => {
    render(<CreditBalanceCard />);
    expect(screen.getByText(/Organization usage/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /Model credits and eval iterations are shared across this organization/,
      ),
    ).toBeInTheDocument();
  });

  describe("team monthly model", () => {
    beforeEach(() => {
      balanceState = {
        paidCreditsRemaining: 1_500,
        hasPurchaseHistory: true,
        freeDailyPercentUsed: 0,
        freeDailyCreditsRemaining: 0,
        freeDailyCreditsTotal: 0,
        freeDailyResetAt: 0,
        walletLocked: false,
        billingModel: "monthly_per_seat",
        monthlyAllowanceTotal: 18_000,
        monthlyAllowanceRemaining: 13_950,
        monthlyResetAt: Date.now() + 12 * 24 * 60 * 60 * 1000,
      };
    });

    it("renders the monthly allowance row instead of the daily row", () => {
      render(<CreditBalanceCard />);
      const row = screen.getByTestId("usage-monthly");
      expect(within(row).getByText(/Monthly credits/)).toBeInTheDocument();
      expect(within(row).getByText(/13,950 \/ 18,000/)).toBeInTheDocument();
      expect(
        within(row).queryByText(/resets in 12 days/),
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("usage-daily")).not.toBeInTheDocument();
    });

    it("keeps reset timing in the monthly credit tooltip", async () => {
      render(<CreditBalanceCard pricingVersion="v1" />);
      expect(screen.queryByText(/resets in 12 days/)).not.toBeInTheDocument();
      await userEvent.hover(
        screen.getByRole("button", { name: "About Monthly credits" }),
      );
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        "resets in 12 days",
      );
    });

    it("keeps V1 Team monthly eval iterations alongside the draining shared credit pool", () => {
      evalQuotaState = {
        used: 125,
        allowed: 500,
        resetsAt: Date.now() + 86400000,
        windowKind: "month",
      };
      const { rerender } = render(<CreditBalanceCard pricingVersion="v1" />);
      expect(screen.queryByText("Free daily credits")).not.toBeInTheDocument();
      expect(screen.getByTestId("usage-eval-iterations")).toHaveTextContent(
        "Monthly eval iterations",
      );
      expect(screen.getByTestId("usage-eval-iterations")).toHaveTextContent(
        "375 / 500",
      );
      expect(
        screen.getByLabelText("Monthly credits remaining"),
      ).toHaveAttribute("aria-valuenow", "77.5");
      balanceState = { ...balanceState!, monthlyAllowanceRemaining: 9000 };
      rerender(<CreditBalanceCard pricingVersion="v1" />);
      expect(
        screen.getByLabelText("Monthly credits remaining"),
      ).toHaveAttribute("aria-valuenow", "50");
      expect(screen.getByTestId("usage-paid")).toHaveTextContent(
        "1,500 credits",
      );
    });

    it("shows paid top-ups separately from the allowance", () => {
      render(<CreditBalanceCard />);
      const paid = screen.getByTestId("usage-paid");
      expect(within(paid).getByText(/1,500 credits/)).toBeInTheDocument();
    });

    it("surfaces an exhausted notice when allowance and paid are both spent", () => {
      balanceState = {
        ...balanceState!,
        monthlyAllowanceRemaining: 0,
        paidCreditsRemaining: 0,
        hasPurchaseHistory: false,
      };
      render(<CreditBalanceCard canManageCredits />);
      expect(screen.getByTestId("usage-monthly-exhausted")).toHaveTextContent(
        /Monthly credits used/,
      );
    });
  });
});

it("shows daily credits for a v2 free org with granted credits", () => {
  isLoadingState = false;
  balanceState = {
    paidCreditsRemaining: 330,
    hasPurchaseHistory: false,
    freeDailyPercentUsed: 25,
    freeDailyResetAt: Date.now() + 86400000,
    freeDailyCreditsRemaining: 150,
    freeDailyCreditsTotal: 200,
    walletLocked: false,
    billingModel: "daily",
    topUpEligible: false,
  };
  render(<CreditBalanceCard pricingVersion="v2" />);
  expect(screen.getByText("Free daily credits")).toBeInTheDocument();
  expect(screen.getByTestId("usage-daily")).toHaveTextContent("150 / 200");
  expect(screen.queryByTestId("usage-monthly")).not.toBeInTheDocument();
});
