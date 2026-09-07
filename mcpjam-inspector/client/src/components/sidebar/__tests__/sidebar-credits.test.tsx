import { render, screen } from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarCredits } from "@/components/sidebar/sidebar-credits";

let balanceState:
  | {
      paidCreditsRemaining: number;
      hasPurchaseHistory: boolean;
      freeDailyPercentUsed: number;
      freeDailyResetAt: number;
      freeDailyCreditsRemaining: number;
      freeDailyCreditsTotal: number;
      walletLocked: boolean;
      billingModel?: "daily" | "monthly_per_seat";
      monthlyAllowanceTotal?: number;
      monthlyAllowanceRemaining?: number;
      monthlyResetAt?: number | null;
    }
  | undefined;
let isLoadingState = false;
let evalQuotaState:
  | {
      used: number;
      allowed: number | null;
      resetsAt: number;
      windowKind: "day" | "month";
    }
  | undefined;
let billingStatusState:
  { effectivePlan: "free" | "team" | "enterprise" } | undefined;

vi.mock("@/hooks/useCreditBalance", () => ({
  useCreditBalance: () => ({
    balance: balanceState,
    isLoading: isLoadingState,
    hasWorkOsUser: true,
  }),
}));

vi.mock("@/hooks/use-eval-iteration-quota", () => ({
  useEvalIterationQuota: () => ({
    quota: evalQuotaState,
    isLoading: false,
    isAtLimit: false,
  }),
}));

vi.mock("@/hooks/useOrganizationBilling", () => ({
  useOrganizationBillingStatus: () => billingStatusState,
  isPaidPlan: (plan: string) => plan !== "free",
}));

// The hover card renders through a portal in a real browser; keep the content
// inline so the assertions can read it without opening a popover.
vi.mock("@mcpjam/design-system/hover-card", () => ({
  HoverCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  HoverCardTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  HoverCardContent: ({
    children,
    side: _side,
    align: _align,
    sideOffset: _sideOffset,
    ...props
  }: { children: ReactNode } & Record<string, unknown>) => (
    <div {...props}>{children}</div>
  ),
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarMenuButton: ({
    children,
    tooltip: _tooltip,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { tooltip?: string }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

function renderCredits(
  overrides: Partial<React.ComponentProps<typeof SidebarCredits>> = {},
) {
  return render(
    <SidebarCredits
      organizationId="org_a"
      billingUiEnabled
      onExplorePlans={vi.fn()}
      {...overrides}
    />,
  );
}

describe("SidebarCredits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-03T12:00:00Z"));
    balanceState = {
      paidCreditsRemaining: 0,
      hasPurchaseHistory: false,
      freeDailyPercentUsed: 12,
      freeDailyResetAt: Date.now() + 3 * 60 * 60 * 1000,
      freeDailyCreditsRemaining: 264,
      freeDailyCreditsTotal: 300,
      walletLocked: false,
    };
    isLoadingState = false;
    evalQuotaState = undefined;
    billingStatusState = { effectivePlan: "free" };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the footer row and the daily credit bar with reset timing", () => {
    renderCredits();

    expect(screen.getByTestId("sidebar-see-credits")).toHaveTextContent(
      "See credits",
    );
    const dailyRow = screen.getByTestId("sidebar-usage-daily");
    expect(dailyRow).toHaveTextContent("Free daily credits");
    expect(dailyRow).toHaveTextContent("36 / 300");
    expect(dailyRow).toHaveTextContent("resets in 3h");
  });

  it("hides the label on the collapsed rail but keeps the row", () => {
    renderCredits();

    // The rail keeps the icon; the hover card is the only surface that can
    // show the numbers, which is why the row carries no Tooltip of its own.
    expect(screen.getByText("See credits")).toHaveClass(
      "group-data-[collapsible=icon]:hidden",
    );
  });

  it("shows the monthly team allowance without the absolute reset date", () => {
    balanceState = {
      paidCreditsRemaining: 988,
      hasPurchaseHistory: true,
      freeDailyPercentUsed: 0,
      freeDailyResetAt: 0,
      freeDailyCreditsRemaining: 0,
      freeDailyCreditsTotal: 0,
      walletLocked: false,
      billingModel: "monthly_per_seat",
      monthlyAllowanceTotal: 24_000,
      monthlyAllowanceRemaining: 18_000,
      monthlyResetAt: Date.now() + 16 * 24 * 60 * 60 * 1000,
    };

    renderCredits();

    const monthlyRow = screen.getByTestId("sidebar-usage-monthly");
    expect(monthlyRow).toHaveTextContent("Monthly team credits");
    expect(monthlyRow).toHaveTextContent("18,000 / 24,000");
    expect(monthlyRow).toHaveTextContent("resets in 16 days");
    expect(monthlyRow.textContent ?? "").not.toMatch(/resets in 16 days \(/);
    expect(screen.queryByTestId("sidebar-usage-daily")).not.toBeInTheDocument();
  });

  it("hides the eval iteration bar for an organization with no cap", () => {
    evalQuotaState = {
      used: 4,
      allowed: null,
      resetsAt: Date.now() + 60 * 60 * 1000,
      windowKind: "day",
    };

    renderCredits();

    expect(
      screen.queryByTestId("sidebar-usage-eval-iterations"),
    ).not.toBeInTheDocument();
  });

  it("shows the eval iteration bar when the organization has a cap", () => {
    evalQuotaState = {
      used: 12,
      allowed: 50,
      resetsAt: Date.now() + 60 * 60 * 1000,
      windowKind: "day",
    };

    renderCredits();

    const evalRow = screen.getByTestId("sidebar-usage-eval-iterations");
    expect(evalRow).toHaveTextContent("Daily eval iterations");
    expect(evalRow).toHaveTextContent("12 / 50 used");
  });

  it("offers Explore plans on the free plan", () => {
    renderCredits();

    expect(screen.getByText("Free plan")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Explore plans" }),
    ).toBeInTheDocument();
  });

  it("names a paid plan without pitching an upgrade", () => {
    billingStatusState = { effectivePlan: "team" };

    renderCredits();

    expect(screen.getByText("Team plan")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Explore plans" }),
    ).not.toBeInTheDocument();
  });

  it("opens billing from the row and from Explore plans", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const onExplorePlans = vi.fn();
    renderCredits({ onExplorePlans });

    vi.useRealTimers();
    const user = userEvent.setup();

    await user.click(screen.getByTestId("sidebar-see-credits"));
    expect(onExplorePlans).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Explore plans" }));
    expect(onExplorePlans).toHaveBeenCalledTimes(2);
  });

  it("shows a loading shell while the balance is in flight", () => {
    balanceState = undefined;
    isLoadingState = true;

    renderCredits();

    expect(screen.getByTestId("sidebar-usage-daily")).toHaveTextContent(
      "Free daily credits",
    );
  });
});
