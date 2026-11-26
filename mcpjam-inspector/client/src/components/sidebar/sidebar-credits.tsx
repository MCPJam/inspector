import { Info } from "lucide-react";
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
import { useSwarmSponsorshipAllowance } from "@/hooks/use-swarm-sponsorship-allowance";
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
import { withCreditPreviewSample } from "./credit-preview-sample";

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
  const { quota: liveEvalIterationQuota, isLoading: isEvalIterationQuotaLoading } =
    useEvalIterationQuota({ organizationId });
  const { swarm: sponsoredAllowance, quota: evalIterationQuota } =
    withCreditPreviewSample(
      useSwarmSponsorshipAllowance(),
      liveEvalIterationQuota,
    );

  // Settled with nothing to show. Rendering the row anyway leaves a permanent
  // "See credits" whose card is a blank number over an empty bar, which reads
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
  const showExplorePlans = plan !== undefined && !isPaidPlan(plan);
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
  const freeEvalIterations = evalIterationQuota?.starterRemaining;
  // Free grants are one-time, so a used-up grant leaves nothing to show.
  if (freeEvalIterations != null && freeEvalIterations > 0) {
    meters.push({
      label: "Free eval iterations",
      remaining: freeEvalIterations,
      total: FREE_EVAL_ITERATION_GRANT,
      tooltip:
        "A one-time set of eval iterations MCPJam pays for before your organization's credits are used. It does not renew.",
      testId: "sidebar-usage-eval-free",
    });
  }
  if (sponsoredAllowance && sponsoredAllowance.remaining > 0) {
    meters.push({
      label: "Free swarm credits",
      remaining: sponsoredAllowance.remaining,
      total: sponsoredAllowance.granted,
      tooltip:
        "Swarm conversations MCPJam pays for before your organization's credits are used. Which ones qualify depends on the model and environment.",
      testId: "sidebar-usage-swarm-sponsored",
    });
  }

  const creditMeter = meters[0];
  const isLowOnCredits =
    !creditMeter.isLoading &&
    creditMeter.total > 0 &&
    remainingPercent(creditMeter) <= LOW_CREDIT_PERCENT;
  const showUpsell = isLowOnCredits && (showExplorePlans || canBuyCredits);

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
              aria-label="See credits"
              onClick={onOpenBilling}
            >
              <CoinStackIcon aria-hidden="true" className="size-4" />
              <span className="group-data-[collapsible=icon]:hidden">
                See credits
              </span>
              {plan && (
                <span className="ml-auto rounded-full border border-border px-2 py-0.5 text-xs group-data-[collapsible=icon]:hidden">
                  {formatPlanName(plan)}
                </span>
              )}
            </SidebarMenuButton>
          </HoverCardTrigger>
          <HoverCardContent
            side="right"
            align="end"
            sideOffset={8}
            className="w-72 border-0 shadow-lg"
            data-testid="sidebar-credits-card"
          >
            <div className="flex flex-col gap-4">
              {plan ? (
                <div className="flex items-center justify-between gap-2">
                  <Badge className="rounded-full border-transparent bg-primary/15 text-primary hover:bg-primary/15">
                    {formatPlanName(plan)} plan
                  </Badge>
                  {showExplorePlans && !showUpsell ? (
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

              {showUpsell ? (
                <div
                  className="flex gap-2"
                  data-testid="sidebar-credits-upsell"
                >
                  {showExplorePlans ? (
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
                      variant={showExplorePlans ? "outline" : "default"}
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
  /** Optional explainer surfaced via an info icon next to the label. */
  tooltip?: string;
}

const LOW_CREDIT_PERCENT = 10;
// Size of the one-time eval grant (`STARTER_ALLOTMENT` in the backend).
const FREE_EVAL_ITERATION_GRANT = 500;

function remainingPercent({ remaining, total }: UsageMeter): number {
  return total > 0 ? Math.min(100, Math.max(0, (remaining / total) * 100)) : 0;
}

function UsageLabel({ meter }: { meter: UsageMeter }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-pretty">
      {meter.label}
      {meter.tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`About ${meter.label}`}
              // Stop bubbling so the surrounding clickable row (which
              // navigates to billing) doesn't fire when the user is just
              // trying to see the tooltip.
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              className="inline-flex shrink-0 items-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:text-foreground"
            >
              <Info aria-hidden="true" className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent sideOffset={6} className="max-w-60 text-pretty">
            {meter.tooltip}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  );
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
      pace="gradual"
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
          <UsageLabel meter={meter} />
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
