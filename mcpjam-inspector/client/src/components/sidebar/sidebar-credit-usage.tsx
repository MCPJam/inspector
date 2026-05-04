import { Progress } from "@mcpjam/design-system/progress";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import { useCreditBalance } from "@/hooks/useCreditBalance";
import { formatCreditResetText } from "@/lib/credit-usage";
import { cn } from "@/lib/utils";

interface SidebarCreditUsageProps {
  className?: string;
  includeGuests?: boolean;
  variant?: "strip" | "full";
}

export function SidebarCreditUsage({
  className,
  includeGuests = false,
  variant = "strip",
}: SidebarCreditUsageProps = {}) {
  const { balance, isLoading, isAuthenticated } = useCreditBalance({
    includeGuests,
  });

  if (!isLoading && !balance) {
    return null;
  }

  const dailyPercentUsed = balance
    ? Math.round(balance.freeDailyPercentUsed)
    : 0;
  const resetText = balance
    ? formatCreditResetText(balance.freeDailyResetAt)
    : null;
  const paidPercentUsed =
    balance?.paidPercentRemaining != null
      ? Math.round(100 - balance.paidPercentRemaining)
      : 0;
  const hasPaidHistory = balance?.hasPurchaseHistory === true;
  const showGuestUpgradeHint =
    variant === "strip" && includeGuests && !isAuthenticated && !isLoading;

  return (
    <div
      data-testid="sidebar-credit-usage"
      aria-label="Credit usage"
      className={cn("group-data-[collapsible=icon]:hidden", className)}
    >
      <div className={cn("px-2 py-1.5", variant === "full" && "px-2.5 py-2")}>
        {variant === "full" ? (
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Credit usage
          </p>
        ) : null}
        <div
          className={cn(
            "flex flex-col",
            variant === "full" ? "gap-2.5" : "gap-0"
          )}
        >
          <SidebarUsageRow
            label="Daily limit"
            percentText={`${dailyPercentUsed}%${
              variant === "full" ? " used" : ""
            }`}
            eyebrowText={
              showGuestUpgradeHint ? "Sign in for 15× daily usage" : null
            }
            helperText={resetText}
            fillPercent={balance ? balance.freeDailyPercentUsed : 0}
            isLoading={isLoading}
            testId="sidebar-usage-daily"
          />
          {variant === "full" && !isLoading && hasPaidHistory && balance ? (
            <SidebarUsageRow
              label="Paid credits"
              percentText={`${paidPercentUsed}% used`}
              helperText={null}
              fillPercent={paidPercentUsed}
              isLoading={false}
              testId="sidebar-usage-paid"
            />
          ) : null}
        </div>
      </div>
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
}

function SidebarUsageRow({
  label,
  percentText,
  eyebrowText,
  helperText,
  fillPercent,
  isLoading,
  testId,
}: SidebarUsageRowProps) {
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      {eyebrowText && !isLoading ? (
        <span className="truncate text-[10px] leading-none text-muted-foreground">
          {eyebrowText}
        </span>
      ) : null}
      <div className="flex items-center justify-between gap-2 text-[11px] leading-none">
        <span className="min-w-0 truncate font-medium text-foreground">
          {label}
        </span>
        <span className="shrink-0 text-muted-foreground">
          {isLoading ? <Skeleton className="h-3 w-12" /> : percentText}
        </span>
      </div>
      {isLoading ? (
        <Skeleton className="h-1.5 w-full rounded-full" />
      ) : (
        <Progress className="h-1.5 bg-primary/15" value={fillPercent} />
      )}
      {helperText && !isLoading ? (
        <span className="truncate text-[10px] leading-none text-muted-foreground">
          {helperText}
        </span>
      ) : null}
    </div>
  );
}
