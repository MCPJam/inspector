import { Info } from "lucide-react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@mcpjam/design-system/hover-card";
import { Progress } from "@mcpjam/design-system/progress";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { CoinStackIcon } from "@/components/ui/coin-stack-icon";
import { useCreditBalance } from "@/hooks/useCreditBalance";
import { useEvalIterationQuota } from "@/hooks/use-eval-iteration-quota";
import {
  isPaidPlan,
  useOrganizationBillingStatus,
} from "@/hooks/useOrganizationBilling";
import { formatPlanName } from "@/lib/billing-entitlements";
import {
  formatCreditResetText,
  formatMonthlyResetText,
} from "@/lib/credit-usage";
import { getEvalIterationQuotaLabel } from "@/lib/eval-iteration-quota";

interface SidebarCreditsProps {
  organizationId: string;
  billingUiEnabled: boolean;
  /** Opens the organization's billing settings. */
  onExplorePlans: () => void;
}

/**
 * The sidebar's one credit surface: a footer row that opens a hover card with
 * the plan, the credit allowance and the eval-iteration allowance.
 *
 * It used to live inside the project/organization switcher, under the org
 * name. That put a persistent meter in front of the two things the switcher
 * exists for — picking a project and picking an organization — and it was the
 * only reason the switcher's menu was tall enough to need scrolling. Credits
 * are ambient information, so they belong where the other ambient rows are
 * and behind a hover rather than in the way.
 *
 * The full breakdown (top-ups, wallet lock, paid history) stays on
 * Settings › Organization › Billing, which this row links to.
 */
export function SidebarCredits({
  organizationId,
  billingUiEnabled,
  onExplorePlans,
}: SidebarCreditsProps) {
  const { balance, isLoading } = useCreditBalance({ organizationId });
  const billingStatus = useOrganizationBillingStatus(organizationId, {
    enabled: billingUiEnabled,
  });
  const { quota: evalIterationQuota, isLoading: isEvalIterationQuotaLoading } =
    useEvalIterationQuota({ organizationId });

  const showMonthly = balance?.billingModel === "monthly_per_seat";
  const monthlyTotal = balance?.monthlyAllowanceTotal ?? 0;
  const monthlyRemaining = balance?.monthlyAllowanceRemaining ?? 0;
  const resetText = balance
    ? showMonthly
      ? formatMonthlyResetText(balance.monthlyResetAt, {
          // The hover card is as narrow as the old sidebar strip, so it makes
          // the same call: relative days only, no absolute date.
          withDate: false,
        })
      : formatCreditResetText(balance.freeDailyResetAt)
    : null;

  // An org with no iteration cap has nothing to draw a bar for — same rule the
  // billing card uses, so the two surfaces never disagree about whether a
  // limit exists.
  const showEvalIterationUsage =
    isEvalIterationQuotaLoading ||
    (evalIterationQuota !== undefined && evalIterationQuota.allowed !== null);

  const plan = billingStatus?.effectivePlan;
  const planLabel = plan ? `${formatPlanName(plan)} plan` : null;
  const showExplorePlans = plan !== undefined && !isPaidPlan(plan);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <HoverCard openDelay={150} closeDelay={150}>
          {/* No `tooltip=` on the button: on the collapsed rail that renders a
              second popover on the same trigger, and the hover card already
              says everything the tooltip would. */}
          <HoverCardTrigger asChild>
            <SidebarMenuButton
              data-testid="sidebar-see-credits"
              onClick={onExplorePlans}
            >
              <CoinStackIcon aria-hidden="true" className="size-4" />
              <span className="group-data-[collapsible=icon]:hidden">
                See credits
              </span>
            </SidebarMenuButton>
          </HoverCardTrigger>
          <HoverCardContent
            side="right"
            align="end"
            sideOffset={8}
            className="w-64"
            data-testid="sidebar-credits-card"
          >
            <div className="flex flex-col gap-3">
              {planLabel ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-semibold">
                    {planLabel}
                  </span>
                  {showExplorePlans ? (
                    <button
                      type="button"
                      onClick={onExplorePlans}
                      className="shrink-0 text-[11px] font-medium text-primary hover:underline"
                    >
                      Explore plans
                    </button>
                  ) : null}
                </div>
              ) : null}

              <SidebarUsageRow
                label={
                  showMonthly ? "Monthly team credits" : "Free daily credits"
                }
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
                showCoin
                testId={
                  showMonthly ? "sidebar-usage-monthly" : "sidebar-usage-daily"
                }
              />

              {showEvalIterationUsage ? (
                <SidebarUsageRow
                  label={getEvalIterationQuotaLabel(
                    evalIterationQuota?.windowKind,
                  )}
                  percentText={
                    evalIterationQuota && evalIterationQuota.allowed !== null
                      ? `${evalIterationQuota.used.toLocaleString()} / ${evalIterationQuota.allowed.toLocaleString()} used`
                      : ""
                  }
                  helperText={null}
                  fillPercent={
                    evalIterationQuota?.allowed
                      ? Math.min(
                          100,
                          (evalIterationQuota.used /
                            evalIterationQuota.allowed) *
                            100,
                        )
                      : 0
                  }
                  isLoading={isEvalIterationQuotaLoading}
                  testId="sidebar-usage-eval-iterations"
                />
              ) : null}
            </div>
          </HoverCardContent>
        </HoverCard>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

interface SidebarUsageRowProps {
  label: string;
  percentText: string;
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
      <div className="flex items-center justify-between gap-2 text-[11px] leading-none">
        <span className="flex min-w-0 items-center gap-1 truncate font-medium text-foreground">
          {label}
          {tooltip ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`About ${label}`}
                  // Stop bubbling so the surrounding clickable row (which
                  // navigates to billing) doesn't fire when the user is just
                  // trying to see the tooltip.
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
