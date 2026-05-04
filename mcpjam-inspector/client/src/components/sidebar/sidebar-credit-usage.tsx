import { Progress } from "@mcpjam/design-system/progress";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import { useCreditBalance } from "@/hooks/useCreditBalance";
import { formatCreditResetText } from "@/lib/credit-usage";

export function SidebarCreditUsage() {
  const { balance, isLoading } = useCreditBalance();

  if (!isLoading && !balance) {
    return null;
  }

  const dailyPercentUsed = balance ? Math.round(balance.freeDailyPercentUsed) : 0;
  const paidPercentUsed =
    balance?.paidPercentRemaining != null
      ? Math.round(100 - balance.paidPercentRemaining)
      : 0;
  const hasPaidHistory = balance?.hasPurchaseHistory === true;

  return (
    <div
      data-testid="sidebar-credit-usage"
      aria-label="Credit usage"
      className="group-data-[collapsible=icon]:hidden"
    >
      <div className="rounded-md border border-sidebar-border/60 bg-sidebar-accent/25 px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/55">
          Credit usage
        </p>
        <div className="flex flex-col gap-2.5">
          <SidebarUsageRow
            label="Daily limit"
            percentText={`${dailyPercentUsed}% used`}
            helperText={
              balance ? formatCreditResetText(balance.freeDailyResetAt) : null
            }
            fillPercent={balance ? balance.freeDailyPercentUsed : 0}
            isLoading={isLoading}
            testId="sidebar-usage-daily"
          />
          {!isLoading && hasPaidHistory && balance ? (
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
  helperText: string | null;
  fillPercent: number;
  isLoading: boolean;
  testId: string;
}

function SidebarUsageRow({
  label,
  percentText,
  helperText,
  fillPercent,
  isLoading,
  testId,
}: SidebarUsageRowProps) {
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <div className="flex items-center justify-between gap-2 text-[11px] leading-none">
        <span className="min-w-0 truncate font-medium text-sidebar-foreground">
          {label}
        </span>
        <span className="shrink-0 text-sidebar-foreground/60">
          {isLoading ? <Skeleton className="h-3 w-12" /> : percentText}
        </span>
      </div>
      {isLoading ? (
        <Skeleton className="h-1.5 w-full rounded-full" />
      ) : (
        <Progress className="h-1.5 bg-primary/15" value={fillPercent} />
      )}
      {helperText && !isLoading ? (
        <span className="truncate text-[10px] leading-none text-sidebar-foreground/45">
          {helperText}
        </span>
      ) : null}
    </div>
  );
}

