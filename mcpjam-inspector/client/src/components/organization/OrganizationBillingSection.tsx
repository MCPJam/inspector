import { Fragment, useEffect, useRef, useState } from "react";
import { Check, CheckCircle2, CreditCard, Info, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Card, CardContent, CardTitle } from "@mcpjam/design-system/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mcpjam/design-system/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import type {
  BillingInterval,
  OrganizationBillingStatus,
  OrganizationPlan,
  PlanCatalog,
} from "@/hooks/useOrganizationBilling";
import type { CheckoutIntentWithOrganization } from "@/lib/billing-deep-link";
import { guardCheckoutIntentAgainstBillingStatus } from "@/lib/billing-checkout-intent-guard";
import {
  getAnnualDiscountPercent,
  getDisplayPriceCentsForPlan,
} from "@/lib/billing-entitlements";
import { cn } from "@/lib/utils";
import { buildComparePlanSectionsFromCatalog } from "@/components/organization/billing-compare-view-model";
import { type ComparePlanCell } from "@/components/organization/compare-plan-marketing";

const PLAN_ORDER: OrganizationPlan[] = [
  "free",
  "starter",
  "team",
  "enterprise",
];

/** Column highlighted as the recommended tier (matches common pricing-page “Popular”). */
const POPULAR_PLAN: OrganizationPlan = "team";

/** Defines org as the billed scope for plans and limits (vs workspaces). */
const ORG_COMPARE_PLANS_NOTE = "Your organization is the billed unit.";

const LLM_USAGE_SECTION_TITLE = "LLM Usage";
const LLM_USAGE_SECTION_TOOLTIP =
  "LLM usage billing isn’t live yet, so models are currently free. For paid plans, the table reflects the intended $5 per user per day rate limit and may change before billing launches.";

function getPlanRank(plan: OrganizationPlan): number {
  return PLAN_ORDER.indexOf(plan);
}

function getPlanColumnCta(params: {
  plan: OrganizationPlan;
  currentPlan: OrganizationPlan;
  entry: PlanCatalog["plans"][OrganizationPlan];
  billingConfigured: boolean;
  canManageBilling: boolean;
  isBillingActionPending: boolean;
  onDowngradePlan: (
    plan: OrganizationPlan,
    billingInterval: BillingInterval,
  ) => void;
  onStartPlanChange: (
    plan: "starter" | "team",
    billingInterval: BillingInterval,
  ) => Promise<void>;
  billingInterval: BillingInterval;
}): {
  label: string;
  disabled: boolean;
  variant: "default" | "outline" | "secondary";
  onClick?: () => void;
} {
  const {
    plan,
    currentPlan,
    entry,
    billingConfigured,
    canManageBilling,
    isBillingActionPending,
    onDowngradePlan,
    onStartPlanChange,
    billingInterval,
  } = params;

  const isCurrentPlan = currentPlan === plan;
  const isHigherTier = getPlanRank(plan) > getPlanRank(currentPlan);
  const isDowngrade = getPlanRank(plan) < getPlanRank(currentPlan);
  const isEnterprisePlan = plan === "enterprise";

  if (isCurrentPlan) {
    return { label: "Current plan", disabled: true, variant: "outline" };
  }

  if (isEnterprisePlan) {
    return {
      label: "Talk to sales",
      disabled: false,
      variant: "outline",
      onClick: () => {
        window.location.href =
          "mailto:founders@mcpjam.com?subject=MCPJam%20Enterprise";
      },
    };
  }

  if (isDowngrade) {
    return {
      label: "Downgrade",
      disabled:
        !canManageBilling || !billingConfigured || isBillingActionPending,
      variant: "outline",
      onClick: () => void onDowngradePlan(plan, billingInterval),
    };
  }

  if (isHigherTier && entry.isSelfServe) {
    if (plan !== "starter" && plan !== "team") {
      return { label: "Unavailable", disabled: true, variant: "outline" };
    }
    return {
      label: "Upgrade",
      disabled:
        !billingConfigured || !canManageBilling || isBillingActionPending,
      variant: "default",
      onClick: () => void onStartPlanChange(plan, billingInterval),
    };
  }

  return { label: "Unavailable", disabled: true, variant: "outline" };
}

function formatCurrency(
  amount: number,
  currency: string,
  maximumFractionDigits: number,
): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(amount);
}

/** Price line for the compare table; Starter uses flat `/mo` (3-seat cap), Team uses `/seat/mo`. */
function formatPlanPriceLabel(
  plan: OrganizationPlan,
  amountInCents: number | null,
  currency: string,
  interval: BillingInterval,
): string {
  if (amountInCents == null) {
    return interval === "annual" ? "Custom annual" : "Custom pricing";
  }

  if (plan === "starter") {
    if (interval === "monthly") {
      return `${formatCurrency(amountInCents / 100, currency, 0)}/mo`;
    }
    const monthlyEquivalentDollars = amountInCents / 12 / 100;
    return `${formatCurrency(Math.round(monthlyEquivalentDollars), currency, 0)}/mo`;
  }

  if (interval === "monthly") {
    return `${formatCurrency(amountInCents / 100, currency, 0)}/seat/mo`;
  }
  const monthlyEquivalentDollars = amountInCents / 12 / 100;
  return `${formatCurrency(Math.round(monthlyEquivalentDollars), currency, 0)}/seat/mo`;
}

function formatPerSeatCadence(
  plan: OrganizationPlan,
  entry: PlanCatalog["plans"][OrganizationPlan],
  interval: BillingInterval,
): string {
  if (plan === "free") {
    return "No credit card required";
  }
  if (plan === "enterprise") {
    return "Annual commitment";
  }
  if (entry.billingModel === "flat") {
    return interval === "annual"
      ? "Flat rate, billed annually"
      : "Flat rate, billed monthly";
  }
  return interval === "annual"
    ? "Per seat, billed annually"
    : "Per seat, billed monthly";
}

const PER_SEAT_MO_SUFFIX = "/seat/mo";
const PER_MO_SUFFIX = "/mo";

function PlanPriceDisplay({ label }: { label: string }) {
  if (label.endsWith(PER_SEAT_MO_SUFFIX)) {
    const amount = label.slice(0, -PER_SEAT_MO_SUFFIX.length);
    return (
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1 gap-y-0">
        <span className="text-3xl font-semibold tabular-nums tracking-tight">
          {amount}
        </span>
        <span className="text-sm font-semibold text-muted-foreground">
          {PER_SEAT_MO_SUFFIX}
        </span>
      </div>
    );
  }

  if (label.endsWith(PER_MO_SUFFIX)) {
    const amount = label.slice(0, -PER_MO_SUFFIX.length);
    return (
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1 gap-y-0">
        <span className="text-3xl font-semibold tabular-nums tracking-tight">
          {amount}
        </span>
        <span className="text-sm font-semibold text-muted-foreground">
          {PER_MO_SUFFIX}
        </span>
      </div>
    );
  }

  return (
    <p className="min-w-0 text-3xl font-semibold tabular-nums tracking-tight">
      {label}
    </p>
  );
}

const COMPARE_PLAN_ROW_LABEL_TOOLTIPS: Record<
  string,
  { ariaLabel: string; content: string; contentClassName?: string }
> = {
  "Evals CI/CD runs": {
    ariaLabel: "Included runs and overage pricing",
    content: "Free: hard cap. Overages $0.02/run otherwise.",
    contentClassName: "max-w-[20rem]",
  },
  "Triage Insights": {
    ariaLabel: "About Triage Insights",
    content: "Recommendations for how to improve your server.",
    contentClassName: "max-w-[20rem]",
  },
  "Evaluation traces": {
    ariaLabel: "What are evaluation traces?",
    content:
      "Traces for evaluations: configured user prompts, tool execution, agent reasoning, errors, and latency breakdown for playground and CI/CD runs.",
    contentClassName: "max-w-[26rem]",
  },
  "Sandbox traces": {
    ariaLabel: "What are sandbox traces?",
    content:
      "Traces for sandboxes: testing user prompts, tool execution, agent reasoning, errors, and latency breakdown while running and sharing MCP experiences.",
    contentClassName: "max-w-[26rem]",
  },
  Uptime: {
    ariaLabel: "Included uptime and overage",
    content:
      "Included hours are per plan. Overage after that is billed at $0.003 per minute.",
    contentClassName: "max-w-[20rem]",
  },
  "User Feedback Insights": {
    ariaLabel: "User feedback and usage insights",
    content:
      "User feedback and usage insights, e.g. to inform user intent and more effective product decisions and evaluations.",
    contentClassName: "max-w-[26rem]",
  },
  "Insights Data Export": {
    ariaLabel: "About insights data export",
    content:
      "Export triage and evaluation insights for analysis outside MCPJam.",
    contentClassName: "max-w-[22rem]",
  },
  "Sandbox Insights Data Export": {
    ariaLabel: "About sandbox insights data export",
    content:
      "Export sandbox user feedback and usage insights for analysis outside MCPJam.",
    contentClassName: "max-w-[22rem]",
  },
  Branding: {
    ariaLabel: "About branding",
    content:
      "Custom branding (e.g. logo and colors) on shared sandbox experiences.",
    contentClassName: "max-w-[18rem]",
  },
  Workspaces: {
    ariaLabel: "What is a workspace?",
    content:
      "Workspaces are containers for your MCP servers and related objects.",
    contentClassName: "max-w-[16rem]",
  },
  "Seat limit": {
    ariaLabel: "About seat limits",
    content:
      "Seats don't need to be filled by a member. To add a new member, you'll need to have one empty seat.",
    contentClassName: "max-w-[18rem]",
  },
  "SSO / SAML": {
    ariaLabel: "About SSO",
    content:
      "Single sign-on with SAML for your organization is available on Enterprise.",
    contentClassName: "max-w-[20rem]",
  },
  "Role-based access control (RBAC)": {
    ariaLabel: "About RBAC",
    content:
      "Basic Admin/Member-style access on Team; customizable roles and fine-grained permissions on Enterprise.",
    contentClassName: "max-w-[22rem]",
  },
  "Data processing agreement (DPA)": {
    ariaLabel: "About the DPA",
    content:
      "A legal agreement covering how MCPJam processes personal data on your behalf",
    contentClassName: "max-w-[22rem]",
  },
  "Uptime service level agreement (SLA)": {
    ariaLabel: "About the uptime SLA",
    content:
      "Formal uptime commitment with Enterprise; not offered on lower tiers.",
    contentClassName: "max-w-[18rem]",
  },
};

function ComparePlanRowLabel({
  label,
  tooltipKey,
}: {
  label: string;
  tooltipKey?: string;
}) {
  const tip = COMPARE_PLAN_ROW_LABEL_TOOLTIPS[tooltipKey ?? label];
  if (!tip) {
    return <>{label}</>;
  }
  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <span className="min-w-0">{label}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex shrink-0 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={tip.ariaLabel}
          >
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          sideOffset={6}
          className={cn("text-balance", tip.contentClassName)}
        >
          {tip.content}
        </TooltipContent>
      </Tooltip>
    </span>
  );
}

function ComparePlanMatrixCell({ cell }: { cell: ComparePlanCell }) {
  if (cell.kind === "check") {
    return (
      <span className="flex w-full justify-center">
        <Check className="size-4 shrink-0 text-emerald-600" aria-hidden />
        <span className="sr-only">Included</span>
      </span>
    );
  }
  if (cell.kind === "x") {
    return (
      <span className="flex w-full justify-center text-sm text-muted-foreground/80">
        <span aria-hidden>-</span>
        <span className="sr-only">Not included</span>
      </span>
    );
  }
  return (
    <span
      className={cn(
        "block w-full text-center text-sm text-muted-foreground",
        cell.emphasize && "font-semibold text-foreground",
      )}
    >
      {cell.text}
    </span>
  );
}

function BillingIntervalToggle({
  billingInterval,
  onBillingIntervalChange,
  annualDiscountPct,
}: {
  billingInterval: BillingInterval;
  onBillingIntervalChange: (interval: BillingInterval) => void;
  annualDiscountPct: number;
}) {
  return (
    <div
      role="group"
      aria-label="Billing interval"
      className="inline-flex max-w-full flex-nowrap items-center gap-1 rounded-lg border border-border/70 bg-muted/40 p-1 whitespace-nowrap"
    >
      <button
        type="button"
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1.5 text-sm font-medium transition-colors sm:gap-2 sm:px-3",
          billingInterval === "annual"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground",
        )}
        onClick={() => onBillingIntervalChange("annual")}
      >
        Annual
        <span
          className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary sm:px-2 sm:text-xs"
          title="Starter: savings vs paying the monthly rate for 12 months (e.g. $61×12 vs $588/year)."
        >
          -{annualDiscountPct}%
        </span>
      </button>
      <button
        type="button"
        className={cn(
          "shrink-0 whitespace-nowrap rounded-md px-2 py-1.5 text-sm font-medium transition-colors sm:px-3",
          billingInterval === "monthly"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground",
        )}
        onClick={() => onBillingIntervalChange("monthly")}
      >
        Monthly
      </button>
    </div>
  );
}

interface OrganizationBillingSectionProps {
  billingStatus: OrganizationBillingStatus | undefined;
  organizationName: string;
  planCatalog: PlanCatalog | undefined;
  isLoadingBilling: boolean;
  isLoadingPlanCatalog: boolean;
  isStartingPlanChange: boolean;
  pendingPlanChangeTarget: "starter" | "team" | null;
  isOpeningPortal: boolean;
  onDowngradePlan: (
    plan: OrganizationPlan,
    billingInterval: BillingInterval,
  ) => Promise<void>;
  onStartPlanChange: (
    plan: "starter" | "team",
    billingInterval: BillingInterval,
  ) => Promise<void>;
  onStartAutoPlanChange?: (
    plan: "starter" | "team",
    billingInterval: BillingInterval,
  ) => Promise<void>;
  checkoutIntent?: CheckoutIntentWithOrganization | null;
  onCheckoutIntentConsumed?: () => void;
}

export function OrganizationBillingSection({
  billingStatus,
  organizationName,
  planCatalog,
  isLoadingBilling,
  isLoadingPlanCatalog,
  isStartingPlanChange,
  pendingPlanChangeTarget,
  isOpeningPortal,
  onDowngradePlan,
  onStartPlanChange,
  onStartAutoPlanChange,
  checkoutIntent = null,
  onCheckoutIntentConsumed,
}: OrganizationBillingSectionProps) {
  const autoCheckoutStartedForKeyRef = useRef<string | null>(null);
  const [billingInterval, setBillingInterval] =
    useState<BillingInterval>("monthly");
  const [checkoutPlanNotice, setCheckoutPlanNotice] = useState<{
    reason: "already_on" | "already_higher";
    currentDisplayName: string;
    requestedDisplayName: string;
  } | null>(null);

  useEffect(() => {
    if (checkoutIntent?.interval) {
      setBillingInterval(checkoutIntent.interval);
    }
  }, [checkoutIntent?.interval]);

  useEffect(() => {
    if (billingStatus?.billingInterval === "annual") {
      setBillingInterval((current) =>
        current === "monthly" ? "annual" : current,
      );
    }
  }, [billingStatus?.billingInterval]);

  useEffect(() => {
    if (!checkoutIntent) {
      autoCheckoutStartedForKeyRef.current = null;
      return;
    }

    const intentKey = `${checkoutIntent.organizationId}:${checkoutIntent.plan}:${checkoutIntent.interval}`;

    let cancelled = false;

    const run = async () => {
      if (isLoadingBilling || isLoadingPlanCatalog) {
        return;
      }
      if (!billingStatus || !planCatalog) {
        return;
      }

      const isAutoCheckoutEligible =
        billingStatus.source === "trial" ||
        (billingStatus.source === "free" && billingStatus.plan === "free");

      if (!isAutoCheckoutEligible) {
        if (!cancelled) {
          onCheckoutIntentConsumed?.();
        }
        return;
      }

      if (!billingStatus.billingConfigured || !billingStatus.canManageBilling) {
        if (!cancelled) {
          toast.error(
            !billingStatus.canManageBilling
              ? "Only organization owners can start checkout."
              : "Checkout isn't available in this environment.",
          );
          onCheckoutIntentConsumed?.();
        }
        return;
      }

      const intentGuard = guardCheckoutIntentAgainstBillingStatus(
        billingStatus,
        checkoutIntent.plan,
      );
      if (!intentGuard.proceed) {
        if (!cancelled && autoCheckoutStartedForKeyRef.current !== intentKey) {
          autoCheckoutStartedForKeyRef.current = intentKey;
          const currentEntry = planCatalog.plans[intentGuard.currentPlan];
          const requestedEntry = planCatalog.plans[checkoutIntent.plan];
          setCheckoutPlanNotice({
            reason: intentGuard.reason,
            currentDisplayName: currentEntry.displayName,
            requestedDisplayName: requestedEntry.displayName,
          });
          onCheckoutIntentConsumed?.();
        }
        return;
      }

      if (autoCheckoutStartedForKeyRef.current === intentKey) {
        return;
      }
      autoCheckoutStartedForKeyRef.current = intentKey;

      try {
        await (onStartAutoPlanChange ?? onStartPlanChange)(
          checkoutIntent.plan,
          checkoutIntent.interval,
        );
        if (!cancelled) {
          onCheckoutIntentConsumed?.();
        }
      } catch {
        if (!cancelled) {
          onCheckoutIntentConsumed?.();
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [
    billingStatus,
    checkoutIntent,
    isLoadingBilling,
    isLoadingPlanCatalog,
    onCheckoutIntentConsumed,
    onStartAutoPlanChange,
    onStartPlanChange,
    planCatalog,
  ]);

  const currentPlan = billingStatus?.plan ?? "free";
  const billingConfigured = billingStatus?.billingConfigured ?? false;
  const canManageBilling = billingStatus?.canManageBilling ?? false;
  const isBillingActionPending = isStartingPlanChange || isOpeningPortal;
  const annualDiscountPct = getAnnualDiscountPercent(planCatalog);
  const compareSections = planCatalog
    ? buildComparePlanSectionsFromCatalog(planCatalog)
    : null;

  return (
    <div className="space-y-5">
      <Dialog
        open={checkoutPlanNotice !== null}
        onOpenChange={(open) => {
          if (!open) setCheckoutPlanNotice(null);
        }}
      >
        {checkoutPlanNotice ? (
          <DialogContent
            className="gap-0 overflow-hidden border-border/80 p-0 sm:max-w-md"
            aria-describedby={undefined}
          >
            <div className="border-b border-border/60 bg-muted/25 px-6 py-5">
              <div className="flex items-start gap-4">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary shadow-sm">
                  <CheckCircle2 className="size-5" aria-hidden />
                </span>
                <DialogHeader className="flex-1 gap-1.5 space-y-0 text-left">
                  <DialogTitle className="text-xl font-semibold tracking-tight text-foreground">
                    {checkoutPlanNotice.reason === "already_higher"
                      ? "You’re already on a higher plan"
                      : "You’re already on this plan"}
                  </DialogTitle>
                  <DialogDescription asChild>
                    <div className="space-y-3 pt-1 text-sm leading-relaxed text-muted-foreground">
                      {checkoutPlanNotice.reason === "already_higher" ? (
                        <>
                          <p>
                            Your organization is on{" "}
                            <span className="font-medium text-foreground">
                              {checkoutPlanNotice.currentDisplayName}
                            </span>
                            . The link you followed was for{" "}
                            <span className="font-medium text-foreground">
                              {checkoutPlanNotice.requestedDisplayName}
                            </span>
                            , which would be a downgrade.
                          </p>
                          <p className="text-xs text-muted-foreground/90">
                            To change plans or manage billing, use the actions
                            in the comparison table below or open the billing
                            portal.
                          </p>
                        </>
                      ) : (
                        <>
                          <p>
                            You’re already subscribed to{" "}
                            <span className="font-medium text-foreground">
                              {checkoutPlanNotice.currentDisplayName}
                            </span>
                            . There’s no need to check out again for the same
                            plan.
                          </p>
                          <p className="text-xs text-muted-foreground/90">
                            If you meant to change interval or payment method,
                            use Manage billing or the options below.
                          </p>
                        </>
                      )}
                    </div>
                  </DialogDescription>
                </DialogHeader>
              </div>
            </div>
            <DialogFooter className="border-t border-border/50 bg-background/80 px-6 py-4 sm:justify-center">
              <Button
                type="button"
                className="min-w-[8rem]"
                onClick={() => setCheckoutPlanNotice(null)}
              >
                Got it
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>

      {checkoutIntent ? (
        <div
          className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
          data-testid="billing-deep-link-redirect"
        >
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
          Redirecting to checkout…
        </div>
      ) : null}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <CreditCard
            className="size-5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          Plans & Billing
        </div>
        <p className="text-sm text-muted-foreground">
          Compare plans, review your current subscription, and start billing
          changes for {organizationName}.
        </p>
      </div>

      {isLoadingBilling ? (
        <div className="rounded-md border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
          Loading billing details...
        </div>
      ) : billingStatus ? (
        <>
          {!billingConfigured ? (
            <div className="rounded-md border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
              Billing is not configured in this environment. Plans are visible,
              but purchase actions are unavailable.
            </div>
          ) : null}
          {!canManageBilling ? (
            <p className="text-sm text-muted-foreground">
              Only organization owners can manage billing changes. Admins can
              review plan details here.
            </p>
          ) : null}
        </>
      ) : null}

      <Card className="border-border/60 py-6 shadow-sm">
        <CardContent className="px-0 pb-0 pt-0">
          {isLoadingPlanCatalog || !planCatalog ? (
            <div className="px-4 py-6 sm:px-6">
              <div className="mb-4 space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wider text-primary">
                  Compare plans
                </p>
                <CardTitle className="text-sm font-semibold leading-snug sm:text-base">
                  Find the right plan for your team
                </CardTitle>
                <p className="pt-1 text-xs leading-snug text-muted-foreground">
                  {ORG_COMPARE_PLANS_NOTE}
                </p>
              </div>
              <div className="mb-4">
                <BillingIntervalToggle
                  billingInterval={billingInterval}
                  onBillingIntervalChange={setBillingInterval}
                  annualDiscountPct={annualDiscountPct}
                />
              </div>
              <div className="rounded-md border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
                Loading plan catalog...
              </div>
            </div>
          ) : (
            <div className="relative w-full overflow-x-auto overscroll-x-contain">
              <div className="min-w-[56rem] px-4 pb-6 sm:px-6">
                <Table>
                  <TableHeader>
                    <TableRow className="border-b hover:bg-transparent [&_th]:align-top [&_th]:h-full">
                      <TableHead className="sticky left-0 z-20 h-full min-h-0 w-[26%] min-w-[11rem] whitespace-normal bg-card text-left shadow-[1px_0_0_0_hsl(var(--border))] px-4 pt-5 pb-4 align-top">
                        <div className="flex h-full min-h-[11rem] flex-col">
                          <div className="flex min-h-0 flex-1 flex-col">
                            <div className="space-y-1 pr-1">
                              <p className="text-xs font-semibold uppercase tracking-wider text-primary">
                                Compare plans
                              </p>
                              <CardTitle className="text-sm font-semibold leading-snug sm:text-base">
                                Find the right plan for your team
                              </CardTitle>
                              <p className="pt-1 text-xs leading-snug text-muted-foreground">
                                {ORG_COMPARE_PLANS_NOTE}
                              </p>
                            </div>
                            <div className="min-h-0 flex-1" aria-hidden />
                          </div>
                          <div className="shrink-0">
                            <BillingIntervalToggle
                              billingInterval={billingInterval}
                              onBillingIntervalChange={setBillingInterval}
                              annualDiscountPct={annualDiscountPct}
                            />
                          </div>
                        </div>
                      </TableHead>
                      {PLAN_ORDER.map((plan) => {
                        const entry = planCatalog.plans[plan];
                        const isEnterprisePlan = plan === "enterprise";
                        const displayCents =
                          plan === "free" || isEnterprisePlan
                            ? null
                            : getDisplayPriceCentsForPlan(
                                plan,
                                billingInterval,
                                entry,
                              );
                        const priceLabel = isEnterprisePlan
                          ? "Custom"
                          : plan === "free"
                            ? "$0"
                            : formatPlanPriceLabel(
                                plan,
                                displayCents,
                                planCatalog.currency,
                                billingInterval,
                              );
                        const priceSubtext = isEnterprisePlan
                          ? formatPerSeatCadence(plan, entry, billingInterval)
                          : plan === "free"
                            ? "No credit card required"
                            : formatPerSeatCadence(
                                plan,
                                entry,
                                billingInterval,
                              );
                        const cta = getPlanColumnCta({
                          plan,
                          currentPlan,
                          entry,
                          billingConfigured,
                          canManageBilling,
                          isBillingActionPending,
                          onDowngradePlan: (
                            targetPlan,
                            targetBillingInterval,
                          ) =>
                            void onDowngradePlan(
                              targetPlan,
                              targetBillingInterval,
                            ),
                          onStartPlanChange,
                          billingInterval,
                        });
                        const showPlanChangeSpinner =
                          pendingPlanChangeTarget === plan &&
                          (cta.label === "Upgrade" ||
                            cta.label === "Downgrade") &&
                          (plan === "starter" || plan === "team");
                        const showCtaSpinner = showPlanChangeSpinner;
                        const isPopular = plan === POPULAR_PLAN;
                        return (
                          <TableHead
                            key={plan}
                            className={cn(
                              "h-full min-h-0 whitespace-normal px-3 pt-5 pb-4 text-center align-top",
                              isPopular &&
                                "border-x border-primary/35 bg-primary/[0.06]",
                            )}
                          >
                            <div className="mx-auto flex h-full min-h-[11rem] w-full max-w-[13rem] flex-col">
                              <div className="flex min-h-0 flex-1 flex-col items-center gap-3">
                                <div className="flex flex-wrap items-center justify-center gap-2">
                                  <span className="text-base font-semibold">
                                    {entry.displayName}
                                  </span>
                                  {isPopular ? (
                                    <Badge className="rounded-md bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground">
                                      Popular
                                    </Badge>
                                  ) : null}
                                </div>
                                <div className="w-full space-y-1">
                                  <PlanPriceDisplay label={priceLabel} />
                                  <p className="text-xs leading-snug text-muted-foreground">
                                    {priceSubtext}
                                  </p>
                                  {entry.seatMinimum ? (
                                    <p className="text-xs leading-snug text-muted-foreground">
                                      {entry.seatMinimum} seat minimum
                                    </p>
                                  ) : null}
                                </div>
                              </div>
                              <Button
                                className="w-full shrink-0 rounded-lg"
                                size="sm"
                                variant={cta.variant}
                                disabled={cta.disabled}
                                onClick={cta.onClick}
                              >
                                {showCtaSpinner ? (
                                  <>
                                    <Loader2 className="size-4 animate-spin" />
                                    Loading...
                                  </>
                                ) : (
                                  cta.label
                                )}
                              </Button>
                            </div>
                          </TableHead>
                        );
                      })}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(compareSections ?? []).map((section) => (
                      <Fragment key={section.title}>
                        <TableRow className="border-b hover:bg-transparent">
                          <TableCell
                            className="bg-muted/40 py-2.5 pl-4"
                            colSpan={PLAN_ORDER.length + 1}
                          >
                            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                              {section.title === LLM_USAGE_SECTION_TITLE ? (
                                <span className="inline-flex items-center gap-1.5">
                                  <span>{section.title}</span>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <button
                                        type="button"
                                        className="inline-flex shrink-0 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        aria-label="LLM usage pricing note"
                                      >
                                        <Info className="size-3.5" />
                                      </button>
                                    </TooltipTrigger>
                                    <TooltipContent
                                      side="right"
                                      sideOffset={6}
                                      className="max-w-[22rem] text-balance"
                                    >
                                      {LLM_USAGE_SECTION_TOOLTIP}
                                    </TooltipContent>
                                  </Tooltip>
                                </span>
                              ) : (
                                section.title
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                        {section.rows.map((row, rowIndex) => {
                          const cells: ComparePlanCell[] = [
                            row.free,
                            row.starter,
                            row.team,
                            row.enterprise,
                          ];
                          return (
                            <TableRow
                              key={`${section.title}-${rowIndex}-${row.label}`}
                              className="border-b"
                            >
                              <TableCell className="sticky left-0 z-10 max-w-[14rem] bg-card py-3 pl-4 text-sm font-medium shadow-[1px_0_0_0_hsl(var(--border))] sm:max-w-none">
                                <ComparePlanRowLabel
                                  label={row.label}
                                  tooltipKey={row.tooltipKey}
                                />
                              </TableCell>
                              {PLAN_ORDER.map((plan, i) => {
                                const isPopular = plan === POPULAR_PLAN;
                                return (
                                  <TableCell
                                    key={plan}
                                    className={cn(
                                      "max-w-[13rem] whitespace-normal px-3 py-3 text-center align-middle text-sm",
                                      isPopular &&
                                        "border-x border-primary/35 bg-primary/[0.06]",
                                    )}
                                  >
                                    <ComparePlanMatrixCell cell={cells[i]!} />
                                  </TableCell>
                                );
                              })}
                            </TableRow>
                          );
                        })}
                      </Fragment>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
