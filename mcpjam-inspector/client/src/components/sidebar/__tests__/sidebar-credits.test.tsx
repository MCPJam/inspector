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
      billingModel?: "daily" | "monthly_per_seat" | "monthly_flat";
      monthlyAllowanceTotal?: number;
      monthlyAllowanceRemaining?: number;
      monthlyResetAt?: number | null;
    }
  | undefined;
let isLoadingState = false;
let evalQuotaState:
  | {
      starterRemaining?: number;
      used: number;
      allowed: number | null;
      resetsAt: number;
      windowKind: "day" | "month";
    }
  | undefined;
let billingStatusState:
  | {
      effectivePlan: "free" | "team" | "enterprise";
      pricingVersion?: "v1" | "v2";
    }
  | undefined;

vi.mock("@/hooks/useCreditBalance", () => ({
  useCreditBalance: () => ({
    balance: balanceState,
    isLoading: isLoadingState,
    hasWorkOsUser: true,
  }),
}));

vi.mock("@/hooks/use-eval-iteration-quota", () => ({
  useEvalIterationQuota: ({ enabled = true }: { enabled?: boolean }) => ({
    quota: enabled ? evalQuotaState : undefined,
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

  it("keeps the current plan visible in the collapsed hover trigger", () => {
    renderCredits();
    expect(screen.getByTestId("sidebar-see-credits")).toHaveTextContent("Free");
  });

  it("renders the footer row and the daily credit bar with reset timing", () => {
    renderCredits();

    expect(screen.getByTestId("sidebar-see-credits")).toHaveTextContent(
      "See credits",
    );
    const dailyRow = screen.getByTestId("sidebar-usage-daily");
    expect(dailyRow).toHaveTextContent("Free daily credits");
    expect(dailyRow).toHaveTextContent("264 / 300");
    expect(dailyRow).toHaveTextContent("resets in 3h");
  });

  it("hides the label on the collapsed rail but keeps the row named", () => {
    renderCredits();

    // The rail keeps the icon; the hover card is the only surface that can
    // show the numbers, which is why the row carries no Tooltip of its own.
    expect(screen.getByText("See credits")).toHaveClass(
      "group-data-[collapsible=icon]:hidden",
    );
    // With the label hidden and the coin decorative, the aria-label is the
    // only accessible name left on the collapsed rail.
    expect(screen.getByTestId("sidebar-see-credits")).toHaveAttribute(
      "aria-label",
      "See credits",
    );
  });

  it("renders nothing once the balance settles with nothing to show", () => {
    // A permanent row over a blank number and an empty bar reads as a broken
    // meter rather than as absent data.
    balanceState = undefined;
    isLoadingState = false;

    renderCredits();

    expect(screen.queryByTestId("sidebar-see-credits")).not.toBeInTheDocument();
  });

  it("names each meter for screen readers", () => {
    evalQuotaState = {
      used: 12,
      allowed: 50,
      resetsAt: Date.now() + 60 * 60 * 1000,
      windowKind: "day",
    };

    renderCredits();

    const daily = screen.getByRole("progressbar", {
      name: "Free daily credits",
    });
    expect(daily).toHaveAttribute("aria-valuetext", "264 / 300");
    expect(
      screen.getByRole("progressbar", { name: "Daily eval iterations" }),
    ).toHaveAttribute("aria-valuetext", "38 / 50 remaining");
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
    expect(monthlyRow).toHaveTextContent("Monthly credits");
    expect(monthlyRow).toHaveTextContent("18,000 / 24,000");
    expect(monthlyRow).toHaveTextContent("resets in 16 days");
    expect(monthlyRow.textContent ?? "").not.toMatch(/resets in 16 days \(/);
    expect(screen.queryByTestId("sidebar-usage-daily")).not.toBeInTheDocument();
  });

  it("lists shared paid credits under the plan allowance without merging them", () => {
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

    const paidRow = screen.getByTestId("sidebar-usage-paid");
    expect(paidRow).toHaveTextContent("Shared paid credits");
    expect(paidRow).toHaveTextContent("988 credits");
    // Absolute count, no denominator: no bar to draw.
    expect(
      screen.queryByRole("progressbar", { name: "Shared paid credits" }),
    ).not.toBeInTheDocument();
    // The monthly row is exactly what it was; the two pools stay apart.
    const monthlyRow = screen.getByTestId("sidebar-usage-monthly");
    expect(monthlyRow).toHaveTextContent("18,000 / 24,000");
    expect(monthlyRow).not.toHaveTextContent("988");
  });

  it("renders no paid credits row at all when the pool is empty", () => {
    // Default state has paidCreditsRemaining: 0.
    renderCredits();

    expect(screen.queryByTestId("sidebar-usage-paid")).not.toBeInTheDocument();
    expect(screen.queryByText("Shared paid credits")).not.toBeInTheDocument();
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
    expect(evalRow).toHaveTextContent("38 / 50 remaining");
  });

  it("keeps the V2 starter allowance while hiding recurring eval allowances", () => {
    billingStatusState = { effectivePlan: "team", pricingVersion: "v2" };
    balanceState = {
      ...balanceState!,
      billingModel: "monthly_flat",
      monthlyAllowanceTotal: 50000,
      monthlyAllowanceRemaining: 30000,
    };
    evalQuotaState = {
      starterRemaining: 420,
      used: 12,
      allowed: 500,
      resetsAt: 0,
      windowKind: "month",
    };
    renderCredits();
    expect(
      screen.queryByTestId("sidebar-usage-eval-iterations"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Free daily credits")).not.toBeInTheDocument();
    expect(screen.getByTestId("sidebar-usage-monthly")).toHaveTextContent(
      "30,000 / 50,000",
    );
    expect(screen.getByText(/Free starter eval iterations:/)).toHaveTextContent(
      "420 remaining · one-time allowance of 500",
    );
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

it("shows daily credits for a v2 free org", () => {
  billingStatusState = { effectivePlan: "free", pricingVersion: "v2" };
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
  };
  renderCredits();
  expect(screen.getByTestId("sidebar-usage-daily")).toHaveTextContent(
    "150 / 200",
  );
  expect(screen.queryByTestId("sidebar-usage-monthly")).not.toBeInTheDocument();
});
