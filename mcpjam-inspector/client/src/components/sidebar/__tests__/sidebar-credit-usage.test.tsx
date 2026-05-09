import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarCreditUsage } from "@/components/sidebar/sidebar-credit-usage";

let balanceState:
  | {
      paidPercentRemaining: number | null;
      hasPurchaseHistory: boolean;
      freeDailyPercentUsed: number;
      freeDailyResetAt: number;
    }
  | undefined;
let isLoadingState = false;
let hasWorkOsUserState = true;

vi.mock("@/hooks/useCreditBalance", () => ({
  useCreditBalance: () => ({
    balance: balanceState,
    isLoading: isLoadingState,
    hasWorkOsUser: hasWorkOsUserState,
  }),
}));

describe("SidebarCreditUsage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-03T12:00:00Z"));
    balanceState = {
      paidPercentRemaining: null,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 12,
      freeDailyResetAt: Date.now() + 3 * 60 * 60 * 1000,
    };
    isLoadingState = false;
    hasWorkOsUserState = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the daily limit bar with reset timing", () => {
    render(<SidebarCreditUsage />);

    const dailyRow = screen.getByTestId("sidebar-usage-daily");
    expect(screen.getByLabelText("Credit usage")).toBeInTheDocument();
    expect(dailyRow).toHaveTextContent("Daily limit");
    expect(dailyRow).toHaveTextContent("12%");
    expect(dailyRow).toHaveTextContent("resets in 3h");
    expect(
      screen.queryByText(/15× daily usage/i)
    ).not.toBeInTheDocument();
  });

  it("keeps the sidebar strip focused on daily limits for paid users", () => {
    balanceState = {
      paidPercentRemaining: 25,
      hasPurchaseHistory: true,
      freeDailyPercentUsed: 40,
      freeDailyResetAt: Date.now() + 60 * 60 * 1000,
    };

    render(<SidebarCreditUsage />);

    expect(screen.queryByTestId("sidebar-usage-paid")).not.toBeInTheDocument();
    expect(screen.getByTestId("sidebar-usage-daily")).toHaveTextContent("40%");
  });

  it("shows paid credits in the full account-menu variant", () => {
    balanceState = {
      paidPercentRemaining: 25,
      hasPurchaseHistory: true,
      freeDailyPercentUsed: 40,
      freeDailyResetAt: Date.now() + 60 * 60 * 1000,
    };

    render(<SidebarCreditUsage variant="full" />);

    expect(screen.getByText("Credit usage")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-usage-daily")).toHaveTextContent(
      "40% used"
    );
    const paidRow = screen.getByTestId("sidebar-usage-paid");
    expect(paidRow).toHaveTextContent("Paid credits");
    expect(paidRow).toHaveTextContent("75% used");
    expect(paidRow.textContent ?? "").not.toMatch(/\$/);
    expect(
      screen.queryByText(/15× daily usage/i)
    ).not.toBeInTheDocument();
  });

  it("does not render when there is no balance to show", () => {
    balanceState = undefined;

    render(<SidebarCreditUsage />);

    expect(
      screen.queryByTestId("sidebar-credit-usage")
    ).not.toBeInTheDocument();
  });

  it("renders guest balance data with a sign-in upgrade hint", () => {
    balanceState = {
      paidPercentRemaining: null,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 65,
      freeDailyResetAt: Date.now() + 2 * 60 * 60 * 1000,
    };
    hasWorkOsUserState = false;

    render(<SidebarCreditUsage includeGuests />);

    const dailyRow = screen.getByTestId("sidebar-usage-daily");
    expect(screen.getByTestId("sidebar-credit-usage")).toBeInTheDocument();
    expect(dailyRow).toHaveTextContent("Sign in for 15× daily usage");
    expect(dailyRow).toHaveTextContent("Daily limit");
    expect(dailyRow).toHaveTextContent("65%");
    expect(dailyRow).toHaveTextContent("resets in 2h");
    expect(screen.queryByTestId("sidebar-usage-paid")).not.toBeInTheDocument();
  });

  it("shows a loading shell while credit balance is loading", () => {
    balanceState = undefined;
    isLoadingState = true;

    render(<SidebarCreditUsage />);

    expect(screen.getByTestId("sidebar-credit-usage")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-usage-daily")).toHaveTextContent(
      "Daily limit"
    );
  });
});
