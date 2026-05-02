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
  CreditTopupDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="topup-dialog" /> : null,
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

describe("CreditBalanceCard", () => {
  beforeEach(() => {
    balanceState = {
      paidPercentRemaining: null,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 0,
      freeDailyResetAt: Date.now() + 11 * 60 * 60 * 1000,
    };
    isLoadingState = false;
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
    expect(screen.getByTestId("topup-dialog")).toBeInTheDocument();
  });

  it("clarifies that credits are user-scoped, not org-scoped", () => {
    render(<CreditBalanceCard />);
    expect(screen.getByText(/Your model credits/)).toBeInTheDocument();
    expect(
      screen.getByText(/Credits are linked to your user, not the organization/),
    ).toBeInTheDocument();
  });
});
