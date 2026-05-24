import { Info } from "lucide-react";
import { Progress } from "@mcpjam/design-system/progress";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { useCreditBalance } from "@/hooks/useCreditBalance";
import { formatCreditResetText } from "@/lib/credit-usage";
import { cn } from "@/lib/utils";

interface SidebarCreditUsageProps {
  className?: string;
  includeGuests?: boolean;
  variant?: "strip" | "full";
  onClick?: () => void;
}

export function SidebarCreditUsage({
  className,
  includeGuests = false,
  variant = "strip",
  onClick,
}: SidebarCreditUsageProps = {}) {
  const { balance, isLoading, hasWorkOsUser } = useCreditBalance({
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
    variant === "strip" && includeGuests && !hasWorkOsUser && !isLoading;

  const innerContent = (
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
            tooltip="Used only after your daily free quota runs out."
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
