import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CreditBalanceCard } from "../CreditBalanceCard";

let balanceState:
  | {
      availableCredits: number;
      hasPurchaseHistory: boolean;
      freeDailyPercentUsed: number;
      freeDailyCreditsRemaining: number;
      freeDailyCreditsTotal: number;
      freeDailyResetAt: number;
      walletLocked: boolean;
      billingModel?: "daily" | "monthly_per_seat";
      monthlyAllowanceTotal?: number;
      monthlyAllowanceRemaining?: number;
      monthlyResetAt?: number | null;
      paidCreditsRemaining?: number;
    }
  | undefined = undefined;
let isLoadingState = false;
let creditTopupsFlagState = true;
let teamCreditsFlagState = true;

vi.mock("@/hooks/useCreditBalance", () => ({
  useCreditBalance: () => ({
    balance: balanceState,
    isLoading: isLoadingState,
  }),
}));

vi.mock("@/lib/team-credits-flag", () => ({
  useTeamCreditsUiEnabled: () => teamCreditsFlagState,
}));

vi.mock("@/lib/credit-topups-flag", () => ({
  useCreditTopupsUiEnabled: () => creditTopupsFlagState,
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
      availableCredits: 0,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 0,
      freeDailyCreditsRemaining: 300,
      freeDailyCreditsTotal: 300,
      freeDailyResetAt: Date.now() + 11 * 60 * 60 * 1000,
      walletLocked: false,
    };
    isLoadingState = false;
    creditTopupsFlagState = true;
    teamCreditsFlagState = true;
    window.location.hash = "";
  });

  it("renders nothing when the top-ups UI flag is off", () => {
    creditTopupsFlagState = false;
    const { container } = render(<CreditBalanceCard organizationId="org-1" />);

    expect(container).toBeEmptyDOMElement();
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
      availableCredits: 0,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 9,
      freeDailyCreditsRemaining: 273,
      freeDailyCreditsTotal: 300,
      freeDailyResetAt: Date.now() + 11 * 60 * 60 * 1000,
      walletLocked: false,
    };
    render(<CreditBalanceCard />);

    const dailyRow = screen.getByTestId("usage-daily");
    expect(dailyRow).toHaveTextContent(/27 \/ 300/);
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
      availableCredits: 1200,
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
      availableCredits: -500,
      hasPurchaseHistory: true,
      freeDailyPercentUsed: 0,
      freeDailyCreditsRemaining: 300,
      freeDailyCreditsTotal: 300,
      freeDailyResetAt: Date.now() + 60 * 60 * 1000,
      walletLocked: true,
    };
    render(<CreditBalanceCard />);

    const paidRow = screen.getByTestId("usage-paid");
    expect(paidRow).toHaveTextContent(/-500 credits/);
    // The lock notice lives in its own block, not inside the paid row.
    expect(screen.getByTestId("usage-wallet-locked")).toHaveTextContent(
      /paused pending review/
    );
  });

  it("surfaces the wallet lock notice even with no purchase history", () => {
    // A wallet can be locked (chargeback/dispute) before/without any completed
    // purchase. Gating the notice on purchase history would hide it exactly
    // when the user needs to know spending is paused.
    balanceState = {
      availableCredits: 0,
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
      /paused pending review/
    );
  });

  it("does NOT expose a tooltip trigger on the daily-limit row (no ambiguity to explain there)", () => {
    render(<CreditBalanceCard />);
    const dailyRow = screen.getByTestId("usage-daily");
    expect(
      within(dailyRow).queryByRole("button", { name: /About/i })
    ).not.toBeInTheDocument();
  });

  it("shows an ask-admin hint instead of the Buy credits button for non-managers", () => {
    render(<CreditBalanceCard organizationId="org-1" />);

    expect(
      screen.queryByRole("button", { name: /Buy credits/i })
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("usage-ask-admin")).toHaveTextContent(
      /Ask org admin to top up credits/
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
      "/organizations/org-1/billing?topup=open"
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
    expect(screen.getByText(/Organization model credits/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /Shared credits are available to everyone in this organization/
      )
    ).toBeInTheDocument();
  });

  describe("team monthly model", () => {
    beforeEach(() => {
      balanceState = {
        availableCredits: 19_500,
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
        paidCreditsRemaining: 1_500,
      };
    });

    it("renders the monthly allowance row instead of the daily row", () => {
      render(<CreditBalanceCard />);
      const row = screen.getByTestId("usage-monthly");
      expect(within(row).getByText(/Monthly team credits/)).toBeInTheDocument();
      expect(within(row).getByText(/13,950 \/ 18,000/)).toBeInTheDocument();
      expect(within(row).getByText(/resets in 12 days/)).toBeInTheDocument();
      expect(screen.queryByTestId("usage-daily")).not.toBeInTheDocument();
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
      expect(
        screen.getByTestId("usage-monthly-exhausted")
      ).toHaveTextContent(/Monthly credits used/);
    });

    it("keeps the existing daily and top-up UI when only the team flag is off", async () => {
      const user = userEvent.setup();
      teamCreditsFlagState = false;

      render(<CreditBalanceCard organizationId="org-1" canManageCredits />);

      expect(screen.queryByTestId("usage-monthly")).not.toBeInTheDocument();
      expect(screen.getByTestId("usage-daily")).toHaveTextContent(
        /Free daily credits/
      );
      expect(screen.getByTestId("usage-paid")).toHaveTextContent(
        /19,500 credits/
      );

      await user.click(screen.getByRole("button", { name: /Buy credits/i }));
      expect(screen.getByTestId("topup-dialog")).toBeInTheDocument();
    });
  });
});
