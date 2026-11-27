import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@mcpjam/design-system/hover-card";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Progress } from "@mcpjam/design-system/progress";
import { Skeleton } from "@mcpjam/design-system/skeleton";
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
import { useRefillAnimation } from "./use-refill-animation";

interface SidebarCreditsProps {
  organizationId: string;
  /** Opens the organization's billing settings. */
  onOpenBilling: () => void;
  /** Opens the organization's Plans page. */
  onExplorePlans: () => void;
  /** Opens billing with the credit top-up dialog. */
  onBuyCredits: () => void;
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
  onOpenBilling,
  onExplorePlans,
  onBuyCredits,
}: SidebarCreditsProps) {
  const { balance, isLoading } = useCreditBalance({ organizationId });
  const billingStatus = useOrganizationBillingStatus(organizationId);
  const isV2 =
    billingStatus?.pricingVersion === "v2" ||
    balance?.billingModel === "monthly_flat";
  const { quota: evalIterationQuota, isLoading: isEvalIterationQuotaLoading } =
    useEvalIterationQuota({ organizationId });

  // Settled with nothing to show. Rendering the row anyway leaves a permanent
  // "Credits" whose card is a blank number over an empty bar, which reads
  // as a broken meter rather than as absent data. The meter this replaced made
  // the same call.
  if ((balance?.unlimitedCreditsUntil ?? 0) > Date.now()) return null;
  if (!isLoading && !balance) {
    return null;
  }

  const showMonthly =
    balance?.billingModel === "monthly_per_seat" ||
    balance?.billingModel === "monthly_flat";
  const monthlyTotal = balance?.monthlyAllowanceTotal ?? 0;
  const monthlyRemaining = balance?.monthlyAllowanceRemaining ?? 0;
  const rolloverRemaining = Math.min(
    Math.max(0, balance?.rolloverCreditsRemaining ?? 0),
    Math.max(0, monthlyRemaining),
  );
  const meterCapacity = monthlyTotal + rolloverRemaining;
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
    !isV2 &&
    (isEvalIterationQuotaLoading ||
      (evalIterationQuota !== undefined &&
        evalIterationQuota.allowed !== null));

  const plan = billingStatus?.effectivePlan;
  const isFreePlan = plan !== undefined && !isPaidPlan(plan);
  const canBuyCredits =
    billingStatus?.canManageBilling === true &&
    balance?.topUpEligible !== false &&
    balance?.walletLocked !== true;

  const meters: UsageMeter[] = [
    {
      label: showMonthly ? "Monthly credits" : "Free daily credits",
      remaining: balance
        ? showMonthly
          ? monthlyRemaining
          : balance.freeDailyCreditsRemaining
        : 0,
      total: balance
        ? showMonthly
          ? meterCapacity
          : balance.freeDailyCreditsTotal
        : 0,
      helperText: resetText,
      isLoading,
      testId: showMonthly ? "sidebar-usage-monthly" : "sidebar-usage-daily",
    },
  ];
  if (showEvalIterationUsage) {
    const allowed = evalIterationQuota?.allowed ?? 0;
    meters.push({
      label: getEvalIterationQuotaLabel(evalIterationQuota?.windowKind),
      remaining: Math.max(0, allowed - (evalIterationQuota?.used ?? 0)),
      total: allowed,
      isLoading: isEvalIterationQuotaLoading,
      testId: "sidebar-usage-eval-iterations",
    });
  }
  const creditMeter = meters[0];
  // Same combined balance as Settings' "Top-up credits"; hidden at zero.
  const topUpRemaining = balance?.paidCreditsRemaining ?? 0;
  const showTopUps = !creditMeter.isLoading && topUpRemaining > 0;
  const isLowOnCredits =
    !creditMeter.isLoading &&
    creditMeter.total > 0 &&
    remainingPercent(creditMeter) <= LOW_CREDIT_PERCENT;
  const showUpsell = isLowOnCredits && (isFreePlan || canBuyCredits);
  // Free orgs low on credits get Explore plans as the main button instead.
  const showExplorePlansLink = !(showUpsell && isFreePlan);

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
              // The label is hidden on the collapsed rail and the coin is
              // decorative, which would otherwise leave the button nameless
              // there. No tooltip: see the comment above.
              aria-label="Credits"
              onClick={onOpenBilling}
            >
              <CoinStackIcon aria-hidden="true" className="size-4" />
              <span className="group-data-[collapsible=icon]:hidden">
                Credits
              </span>
            </SidebarMenuButton>
          </HoverCardTrigger>
          <HoverCardContent
            side="right"
            align="end"
            sideOffset={8}
            className="w-80 border-0 shadow-lg"
            data-testid="sidebar-credits-card"
          >
            <div className="flex flex-col gap-4">
              {plan ? (
                <div className="flex items-center justify-between gap-2">
                  <Badge className="rounded-full border-primary/60 bg-primary/10 text-foreground">
                    {formatPlanName(plan)}
                  </Badge>
                  {showExplorePlansLink ? (
                    <button
                      type="button"
                      onClick={onExplorePlans}
                      className="shrink-0 text-xs font-medium text-primary hover:underline"
                    >
                      Explore plans
                    </button>
                  ) : null}
                </div>
              ) : null}

              {meters.map((meter) => (
                <UsageRow
                  key={meter.testId}
                  meter={meter}
                  storageKey={`mcpjam:credits-last-seen:${organizationId}:${meter.testId}`}
                />
              ))}
              {showTopUps ? <TopUpRow remaining={topUpRemaining} /> : null}

              {showUpsell ? (
                <div
                  className="flex gap-2"
                  data-testid="sidebar-credits-upsell"
                >
                  {isFreePlan ? (
                    <Button
                      size="sm"
                      className="flex-1"
                      onClick={onExplorePlans}
                    >
                      Explore plans
                    </Button>
                  ) : null}
                  {canBuyCredits ? (
                    <Button
                      size="sm"
                      variant={isFreePlan ? "outline" : "default"}
                      className="flex-1"
                      onClick={onBuyCredits}
                    >
                      Buy credits
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </HoverCardContent>
        </HoverCard>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

interface UsageMeter {
  label: string;
  remaining: number;
  total: number;
  testId: string;
  helperText?: string | null;
  isLoading?: boolean;
}

const LOW_CREDIT_PERCENT = 10;

function remainingPercent({ remaining, total }: UsageMeter): number {
  return total > 0 ? Math.min(100, Math.max(0, (remaining / total) * 100)) : 0;
}

function UsageBar({
  meter,
  storageKey,
}: {
  meter: UsageMeter;
  storageKey: string;
}) {
  const percent = remainingPercent(meter);
  const filling = useRefillAnimation(
    meter.isLoading ? null : storageKey,
    meter.isLoading ? null : meter.remaining,
  );
  if (meter.isLoading)
    return <Skeleton className="h-1.5 w-full rounded-full" />;
  return (
    <Progress
      value={filling ? 0 : percent}
      pace="fill"
      aria-label={meter.label}
      aria-valuetext={`${meter.remaining.toLocaleString()} / ${meter.total.toLocaleString()} left`}
      className="h-1.5 bg-primary/15"
    />
  );
}

function UsageValue({ meter }: { meter: UsageMeter }) {
  if (meter.isLoading) return <Skeleton className="h-3.5 w-14" />;
  return (
    <span className="shrink-0 whitespace-nowrap tabular-nums">
      <span className="text-sm font-semibold text-foreground">
        {meter.remaining.toLocaleString()}
      </span>
      <span className="text-xs text-muted-foreground">
        {" "}
        / {meter.total.toLocaleString()} left
      </span>
    </span>
  );
}

// Top-ups have no total to draw a bar against, so the row shows only the count.
function TopUpRow({ remaining }: { remaining: number }) {
  return (
    <div
      className="flex items-baseline justify-between gap-3"
      data-testid="sidebar-usage-topup"
    >
      <span className="min-w-0 text-xs font-medium text-foreground">
        Top-up credits
      </span>
      <span className="shrink-0 whitespace-nowrap tabular-nums">
        <span className="text-sm font-semibold text-foreground">
          {remaining.toLocaleString()}
        </span>
        <span className="text-xs text-muted-foreground"> left</span>
      </span>
    </div>
  );
}

function UsageRow({
  meter,
  storageKey,
}: {
  meter: UsageMeter;
  storageKey: string;
}) {
  return (
    <div className="flex flex-col gap-1.5" data-testid={meter.testId}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 text-xs font-medium text-foreground">
          {meter.label}
        </span>
        <UsageValue meter={meter} />
      </div>
      <UsageBar meter={meter} storageKey={storageKey} />
      {meter.helperText && !meter.isLoading ? (
        <span className="text-xs text-muted-foreground">
          {meter.helperText}
        </span>
      ) : null}
    </div>
  );
}
