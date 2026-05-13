import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CreditBalanceCard } from "../CreditBalanceCard";

let balanceState:
  | {
      paidPercentRemaining: number | null;
      hasPurchaseHistory: boolean;
      freeDailyPercentUsed: number;
      freeDailyResetAt: number;
    }
  | undefined = undefined;
let isLoadingState = false;

vi.mock("@/hooks/useCreditBalance", () => ({
  useCreditBalance: () => ({
    balance: balanceState,
    isLoading: isLoadingState,
  }),
}));

vi.mock("@/components/billing/CreditTopupDialog", () => ({
  CreditTopupDialog: ({ open, source }: { open: boolean; source: string }) =>
    open ? (
      <div data-testid="topup-dialog" data-source={source} />
    ) : null,
}));

// Stub the gated button so existing tests don't need to set up the preset
// query. The button's gating logic is covered by TopupActionButton.test.tsx.
vi.mock("@/components/billing/TopupActionButton", () => ({
  TopupActionButton: ({ onClick }: { onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      Top up
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
      paidPercentRemaining: null,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 0,
      freeDailyResetAt: Date.now() + 11 * 60 * 60 * 1000,
    };
    isLoadingState = false;
    window.location.hash = "";
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
      paidPercentRemaining: null,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 9,
      freeDailyResetAt: Date.now() + 11 * 60 * 60 * 1000,
    };
    render(<CreditBalanceCard />);

    const dailyRow = screen.getByTestId("usage-daily");
    expect(dailyRow).toHaveTextContent(/9% used/);
    expect(dailyRow).toHaveTextContent(/resets/);
    // Regression guard: free credit dollar value must never appear.
    expect(dailyRow.textContent ?? "").not.toMatch(/\$/);
  });

  it("hides the paid-credits row when the user has never topped up", () => {
    render(<CreditBalanceCard />);
    expect(screen.queryByTestId("usage-paid")).not.toBeInTheDocument();
  });

  it("renders the paid-credits row as a bare percent, with no dollar value", () => {
    // 32% remaining = 68% used. The bar's right-text is "X% used".
    balanceState = {
      paidPercentRemaining: 32,
      hasPurchaseHistory: true,
      freeDailyPercentUsed: 100,
      freeDailyResetAt: Date.now() + 60 * 60 * 1000,
    };
    render(<CreditBalanceCard />);

    const paidRow = screen.getByTestId("usage-paid");
    expect(paidRow).toHaveTextContent(/68% used/);
    // Regression guard: the paid-credits row must NEVER surface a dollar
    // amount. Pairing a $ with a percent invites the user to compute a
    // wrong remaining-dollars value, and any credited-domain dollar
    // exposes the take rate when the user knows what they paid.
    expect(paidRow.textContent ?? "").not.toMatch(/\$/);
  });

  it("opens the top-up dialog when the Top up button is clicked", async () => {
    const user = userEvent.setup();
    render(<CreditBalanceCard />);

    expect(screen.queryByTestId("topup-dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Top up/i }));
    const dialog = screen.getByTestId("topup-dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog.getAttribute("data-source")).toBe("billing_page");
  });

  it("auto-opens the top-up dialog with limit_modal source when the topup hash flag is present", () => {
    window.location.hash = "organizations/org-1/billing?topup=open";
    render(<CreditBalanceCard />);

    const dialog = screen.getByTestId("topup-dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog.getAttribute("data-source")).toBe("limit_modal");
    // The flag should be consumed so a reload doesn't reopen the dialog.
    expect(window.location.hash).toBe("#organizations/org-1/billing");
  });

  it("does not auto-open when the topup hash flag is absent", () => {
    window.location.hash = "organizations/org-1/billing";
    render(<CreditBalanceCard />);

    expect(screen.queryByTestId("topup-dialog")).not.toBeInTheDocument();
  });

  it("clarifies that credits are user-scoped, not org-scoped", () => {
    render(<CreditBalanceCard />);
    expect(screen.getByText(/Your model credits/)).toBeInTheDocument();
    expect(
      screen.getByText(/Credits are linked to your user, not the organization/),
    ).toBeInTheDocument();
  });
});
