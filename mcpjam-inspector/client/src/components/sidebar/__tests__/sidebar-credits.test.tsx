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
      rolloverCreditsRemaining?: number;
      monthlyAllowanceRemaining?: number;
      monthlyResetAt?: number | null;
      topUpEligible?: boolean;
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
      canManageBilling?: boolean;
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
      onOpenBilling={vi.fn()}
      onExplorePlans={vi.fn()}
      onBuyCredits={vi.fn()}
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
    localStorage.clear();
  });

  it("uses the same rollover capacity as Billing for low credits", () => {
    balanceState = {
      ...balanceState!,
      billingModel: "monthly_flat",
      monthlyAllowanceTotal: 5000,
      monthlyAllowanceRemaining: 550,
      rolloverCreditsRemaining: 550,
    };
    renderCredits();
    expect(screen.getByTestId("sidebar-credits-upsell")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-usage-monthly")).toHaveTextContent(
      "550 / 5,550",
    );
  });

  it("does not label a monthly balance with an unknown allowance as low", () => {
    balanceState = {
      ...balanceState!,
      billingModel: "monthly_flat",
      monthlyAllowanceTotal: undefined,
      monthlyAllowanceRemaining: 500,
    };
    renderCredits();
    expect(
      screen.queryByTestId("sidebar-credits-upsell"),
    ).not.toBeInTheDocument();
  });

  it.each([75, 100, 5])(
    "shows credit balance at %s percent and the upsell only when low",
    (percent) => {
      balanceState = {
        ...balanceState!,
        freeDailyCreditsRemaining: percent * 3,
      };
      renderCredits();
      const meter = screen.getByRole("progressbar", {
        name: "Free daily credits",
      });
      expect(meter).toHaveAttribute(
        "aria-valuetext",
        `${percent * 3} / 300 left`,
      );
      expect(screen.queryByText("Low credits")).not.toBeInTheDocument();
      expect(Boolean(screen.queryByTestId("sidebar-credits-upsell"))).toBe(
        percent <= 10,
      );
    },
  );

  it("leads with Explore plans and offers Buy credits on a low free plan", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    billingStatusState = { effectivePlan: "free", canManageBilling: true };
    balanceState = { ...balanceState!, freeDailyCreditsRemaining: 12 };
    const onBuyCredits = vi.fn();
    renderCredits({ onBuyCredits });

    const upsell = screen.getByTestId("sidebar-credits-upsell");
    const [explore, buy] = upsell.querySelectorAll("button");
    expect(explore).toHaveTextContent("Explore plans");
    expect(buy).toHaveTextContent("Buy credits");
    expect(
      screen.getAllByRole("button", { name: "Explore plans" }),
    ).toHaveLength(1);

    vi.useRealTimers();
    await userEvent.setup().click(buy);
    expect(onBuyCredits).toHaveBeenCalledTimes(1);
  });

  it("offers only Explore plans to a low free member who cannot buy", () => {
    billingStatusState = { effectivePlan: "free", canManageBilling: false };
    balanceState = { ...balanceState!, freeDailyCreditsRemaining: 12 };
    renderCredits();

    expect(screen.getByTestId("sidebar-credits-upsell")).toHaveTextContent(
      "Explore plans",
    );
    expect(
      screen.queryByRole("button", { name: "Buy credits" }),
    ).not.toBeInTheDocument();
  });

  it("offers no top-up when the org is not eligible for one", () => {
    billingStatusState = { effectivePlan: "free", canManageBilling: true };
    balanceState = {
      ...balanceState!,
      freeDailyCreditsRemaining: 12,
      topUpEligible: false,
    };
    renderCredits();

    expect(
      screen.queryByRole("button", { name: "Buy credits" }),
    ).not.toBeInTheDocument();
  });

  it("offers Buy credits alone on a low paid plan, and nothing to a member", () => {
    billingStatusState = { effectivePlan: "team", canManageBilling: true };
    balanceState = { ...balanceState!, freeDailyCreditsRemaining: 12 };
    const { unmount } = renderCredits();
    expect(screen.getByTestId("sidebar-credits-upsell")).toHaveTextContent(
      /^Buy credits$/,
    );
    expect(
      screen.getByRole("button", { name: "Explore plans" }),
    ).toBeInTheDocument();
    unmount();

    billingStatusState = { effectivePlan: "team", canManageBilling: false };
    renderCredits();
    expect(
      screen.queryByTestId("sidebar-credits-upsell"),
    ).not.toBeInTheDocument();
  });

  it("shows no free grant rows, even while a grant remains", () => {
    evalQuotaState = {
      starterRemaining: 420,
      used: 0,
      allowed: null,
      resetsAt: 0,
      windowKind: "day",
    };
    renderCredits();
    expect(
      screen.queryByTestId("sidebar-usage-eval-free"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Free Swarm/)).not.toBeInTheDocument();
  });

  it("names the plan in the card, not the sidebar row", () => {
    renderCredits();
    expect(screen.getByTestId("sidebar-see-credits")).toHaveTextContent(
      /^Credits$/,
    );
    expect(screen.getByText("Free")).toBeInTheDocument();
  });

  it("renders the footer row and the daily credit bar with reset timing", () => {
    renderCredits();

    expect(screen.getByTestId("sidebar-see-credits")).toHaveTextContent(
      "Credits",
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
    expect(screen.getByText("Credits")).toHaveClass(
      "group-data-[collapsible=icon]:hidden",
    );
    // With the label hidden and the coin decorative, the aria-label is the
    // only accessible name left on the collapsed rail.
    expect(screen.getByTestId("sidebar-see-credits")).toHaveAttribute(
      "aria-label",
      "Credits",
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
    expect(daily).toHaveAttribute("aria-valuetext", "264 / 300 left");
    expect(
      screen.getByRole("progressbar", { name: "Daily eval iterations" }),
    ).toHaveAttribute("aria-valuetext", "38 / 50 left");
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

  it("shows top-up credits while any remain, and hides them at zero", () => {
    balanceState = { ...balanceState!, paidCreditsRemaining: 988 };
    const { unmount } = renderCredits();
    const topUps = screen.getByTestId("sidebar-usage-topup");
    expect(topUps).toHaveTextContent("Top-up credits");
    expect(topUps).toHaveTextContent("988 left");
    unmount();

    balanceState = { ...balanceState!, paidCreditsRemaining: 0 };
    renderCredits();
    expect(screen.queryByTestId("sidebar-usage-topup")).not.toBeInTheDocument();
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
    expect(evalRow).toHaveTextContent("38 / 50");
  });

  it("hides eval allowances on v2 plans", () => {
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
    expect(
      screen.queryByTestId("sidebar-usage-eval-free"),
    ).not.toBeInTheDocument();
  });

  it("offers Explore plans on the free plan", () => {
    renderCredits();

    expect(screen.getByText("Free")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Explore plans" }),
    ).toBeInTheDocument();
  });

  it("offers Explore plans on a paid plan too", () => {
    billingStatusState = { effectivePlan: "team" };

    renderCredits();

    expect(screen.getByText("Team")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Explore plans" }),
    ).toBeInTheDocument();
  });

  it("opens billing from the row and plans from Explore plans", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const onOpenBilling = vi.fn();
    const onExplorePlans = vi.fn();
    renderCredits({ onOpenBilling, onExplorePlans });

    vi.useRealTimers();
    const user = userEvent.setup();

    await user.click(screen.getByTestId("sidebar-see-credits"));
    expect(onOpenBilling).toHaveBeenCalledTimes(1);
    expect(onExplorePlans).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Explore plans" }));
    expect(onExplorePlans).toHaveBeenCalledTimes(1);
    expect(onOpenBilling).toHaveBeenCalledTimes(1);
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
