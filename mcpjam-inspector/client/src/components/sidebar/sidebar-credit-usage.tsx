import { Info } from "lucide-react";
import { Progress } from "@mcpjam/design-system/progress";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { CoinStackIcon } from "@/components/ui/coin-stack-icon";
import { useCreditBalance } from "@/hooks/useCreditBalance";
import {
  formatCreditResetText,
  formatMonthlyResetText,
} from "@/lib/credit-usage";
import { cn } from "@/lib/utils";

interface SidebarCreditUsageProps {
  className?: string;
  organizationId?: string | null;
  includeGuests?: boolean;
  variant?: "strip" | "full";
  onClick?: () => void;
}

export function SidebarCreditUsage({
  className,
  organizationId,
  includeGuests = false,
  variant = "strip",
  onClick,
}: SidebarCreditUsageProps = {}) {
  const { balance, isLoading, hasWorkOsUser } = useCreditBalance({
    organizationId,
    includeGuests,
  });

  if (!isLoading && !balance) {
    return null;
  }

  const showMonthly = balance?.billingModel === "monthly_per_seat";
  const monthlyTotal = balance?.monthlyAllowanceTotal ?? 0;
  const monthlyRemaining = balance?.monthlyAllowanceRemaining ?? 0;
  const paidRemaining = balance?.paidCreditsRemaining ?? 0;
  const resetText = balance
    ? showMonthly
      ? formatMonthlyResetText(balance.monthlyResetAt, {
          // Sidebar (both strip and full) drops the absolute date — only the
          // billing card shows it.
          withDate: false,
        })
      : formatCreditResetText(balance.freeDailyResetAt)
    : null;
  const hasPaidHistory = balance?.hasPurchaseHistory === true;
  const showGuestUpgradeHint =
    !showMonthly &&
    variant === "strip" &&
    includeGuests &&
    !hasWorkOsUser &&
    !isLoading;

  const innerContent = (
    <div className={cn("px-2 py-1.5", variant === "full" && "px-2.5 py-2")}>
      <div
        className={cn(
          "flex flex-col",
          variant === "full" ? "gap-2.5" : "gap-0"
        )}
      >
        <SidebarUsageRow
          label={showMonthly ? "Monthly team credits" : "Free daily credits"}
          percentText={
            balance
              ? showMonthly
                ? `${monthlyRemaining.toLocaleString()} / ${monthlyTotal.toLocaleString()}`
                : `${(
                    balance.freeDailyCreditsTotal -
                    balance.freeDailyCreditsRemaining
                  ).toLocaleString()} / ${balance.freeDailyCreditsTotal.toLocaleString()}`
              : ""
          }
          eyebrowText={
            showGuestUpgradeHint ? "Sign in for 10× the credits" : null
          }
          helperText={resetText}
          fillPercent={
            balance
              ? showMonthly
                ? monthlyTotal > 0
                  ? (monthlyRemaining / monthlyTotal) * 100
                  : 0
                : balance.freeDailyCreditsTotal > 0
                ? ((balance.freeDailyCreditsTotal -
                    balance.freeDailyCreditsRemaining) /
                    balance.freeDailyCreditsTotal) *
                  100
                : 0
              : 0
          }
          isLoading={isLoading}
          // Signed-in only — guests don't get the coin accent.
          showCoin={hasWorkOsUser}
          testId={showMonthly ? "sidebar-usage-monthly" : "sidebar-usage-daily"}
        />
        {variant === "full" && !isLoading && hasPaidHistory && balance ? (
          <SidebarUsageRow
            label="Paid credits"
            percentText={`${paidRemaining.toLocaleString()}`}
            helperText={null}
            // Absolute credit count, not a percentage — render no progress
            // bar (a permanently 0%-filled bar reads as a bug).
            showBar={false}
            showCoin
            fillPercent={0}
            isLoading={false}
            testId="sidebar-usage-paid"
            tooltip={
              showMonthly
                ? "Shared across your organization. Spent after monthly team credits run out."
                : "Shared across your organization. Spent after the free daily credits run out."
            }
          />
        ) : null}
      </div>
    </div>
  );

  if (onClick) {
    // Use div+role=button instead of a real <button> so the tooltip
    // trigger (which is itself a <button>) on the paid-credits row
    // doesn't nest buttons — invalid HTML, plus breaks tooltip focus.
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onClick();
          }
        }}
        data-testid="sidebar-credit-usage"
        aria-label="Credit usage"
        className={cn(
          "group-data-[collapsible=icon]:hidden w-full text-left rounded-md cursor-pointer hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          className
        )}
      >
        {innerContent}
      </div>
    );
  }

  return (
    <div
      data-testid="sidebar-credit-usage"
      aria-label="Credit usage"
      className={cn("group-data-[collapsible=icon]:hidden", className)}
    >
      {innerContent}
    </div>
  );
}

interface SidebarUsageRowProps {
  label: string;
  percentText: string;
  eyebrowText?: string | null;
  helperText: string | null;
  fillPercent: number;
  isLoading: boolean;
  testId: string;
  /** Render the progress bar. Off for absolute counts with no denominator. */
  showBar?: boolean;
  /** Prefix the value with a coin icon — used for credit-balance amounts. */
  showCoin?: boolean;
  /** Optional explainer surfaced via an info icon next to the label. */
  tooltip?: string;
}

function SidebarUsageRow({
  label,
  percentText,
  eyebrowText,
  helperText,
  fillPercent,
  isLoading,
  testId,
  showBar = true,
  showCoin = false,
  tooltip,
}: SidebarUsageRowProps) {
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      {eyebrowText && !isLoading ? (
        <span className="truncate text-[10px] leading-none text-muted-foreground">
          {eyebrowText}
        </span>
      ) : null}
      <div className="flex items-center justify-between gap-2 text-[11px] leading-none">
        <span className="flex min-w-0 items-center gap-1 truncate font-medium text-foreground">
          {label}
          {tooltip ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`About ${label}`}
                  // Stop bubbling so the surrounding clickable wrapper (the
                  // sidebar row that navigates to billing on click) doesn't
                  // fire when the user is just trying to see the tooltip.
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                  className="inline-flex items-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:text-foreground"
                >
                  <Info aria-hidden="true" className="size-2.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent sideOffset={6}>{tooltip}</TooltipContent>
            </Tooltip>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
          {isLoading ? (
            <Skeleton className="h-3 w-12" />
          ) : (
            <>
              {showCoin ? (
                <CoinStackIcon aria-hidden="true" className="size-3 shrink-0" />
              ) : null}
              {percentText}
            </>
          )}
        </span>
      </div>
      {showBar ? (
        isLoading ? (
          <Skeleton className="h-1.5 w-full rounded-full" />
        ) : (
          <Progress className="h-1.5 bg-primary/15" value={fillPercent} />
        )
      ) : null}
      {helperText && !isLoading ? (
        <span className="truncate text-[10px] leading-none text-muted-foreground">
          {helperText}
        </span>
      ) : null}
    </div>
  );
}
