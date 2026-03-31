import { Box, Loader2, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  OrganizationBillingStatus,
  PlanCatalog,
} from "@/hooks/useOrganizationBilling";
import { formatPlanName } from "@/lib/billing-entitlements";

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

export function getCurrentPlanRenewalLine(
  billingStatus: OrganizationBillingStatus,
  formattedPeriodEnd: string,
): string {
  if (billingStatus.stripeCurrentPeriodEnd != null) {
    return `Renews ${formattedPeriodEnd}`;
  }
  if (billingStatus.plan === "free" || !billingStatus.hasCustomer) {
    return "No active subscription";
  }
  if (billingStatus.subscriptionStatus) {
    return billingStatus.subscriptionStatus.replace(/_/g, " ");
  }
  return "Not available";
}

function formatCurrentPlanBillingDetailLine(
  billingStatus: OrganizationBillingStatus,
  planCatalog: PlanCatalog,
): string | null {
  if (billingStatus.source === "trial") {
    return "7-day trial · no active subscription yet";
  }

  const plan = billingStatus.plan ?? "free";
  const interval = billingStatus.billingInterval ?? "monthly";
  const entry = planCatalog.plans[plan];
  if (!entry) {
    return null;
  }
  if (plan === "free" || entry.billingModel === "free") {
    return "No credit card required";
  }
  if (plan === "enterprise") {
    return "Annual commitment · Contact sales for pricing";
  }
  const priceCents = entry.prices[interval];
  if (priceCents == null) {
    return null;
  }
  const monthlyAmount =
    interval === "annual" ? priceCents / 12 / 100 : priceCents / 100;
  const money = formatCurrency(monthlyAmount, planCatalog.currency, 2);
  if (entry.billingModel === "flat") {
    return `${money} flat monthly rate, ${interval === "annual" ? "billed annually" : "billed monthly"}`;
  }
  const seatMinimumSuffix = entry.seatMinimum
    ? ` · ${entry.seatMinimum} seat minimum`
    : "";
  return `${money} per seat/month, ${interval === "annual" ? "billed annually" : "billed monthly"}${seatMinimumSuffix}`;
}

export interface OrganizationCurrentPlanPanelProps {
  billingStatus: OrganizationBillingStatus;
  planCatalog: PlanCatalog | undefined;
  isLoadingPlanCatalog: boolean;
  onManageBilling: () => Promise<void>;
  isOpeningPortal: boolean;
}

export function OrganizationCurrentPlanPanel({
  billingStatus,
  planCatalog,
  isLoadingPlanCatalog,
  onManageBilling,
  isOpeningPortal,
}: OrganizationCurrentPlanPanelProps) {
  const currentPlan = billingStatus.plan ?? "free";
  const displayPlan =
    billingStatus.source === "trial"
      ? billingStatus.trialPlan ?? billingStatus.effectivePlan
      : currentPlan;
  const billingConfigured = billingStatus.billingConfigured ?? false;
  const canManageBilling = billingStatus.canManageBilling ?? false;
  const isTrial = billingStatus.source === "trial";
  const formattedPeriodEnd =
    billingStatus.stripeCurrentPeriodEnd != null
      ? new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        }).format(new Date(billingStatus.stripeCurrentPeriodEnd))
      : "Not available";
  const subscriptionStatusLabel = billingStatus.subscriptionStatus
    ? billingStatus.subscriptionStatus.replace(/_/g, " ")
    : "Not subscribed";
  const formattedTrialEnd =
    billingStatus.trialEndsAt != null
      ? new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        }).format(new Date(billingStatus.trialEndsAt))
      : "Not available";

  const effectiveBillingInterval =
    billingStatus.billingInterval ?? "monthly";
  const billingDetailLine = planCatalog
    ? formatCurrentPlanBillingDetailLine(billingStatus, planCatalog)
    : null;

  const showIntervalPortalLink =
    billingConfigured &&
    canManageBilling &&
    !isTrial &&
    (currentPlan === "starter" || currentPlan === "team") &&
    billingStatus.billingInterval != null;

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border/70 bg-muted/20 p-5 md:p-6">
      <p className="text-xs text-muted-foreground">
        {isTrial ? (
          <>
            <span className="font-medium text-foreground/80">
              Trial status
            </span>{" "}
            <span className="capitalize">{billingStatus.trialStatus}</span>
            <span className="text-muted-foreground/70"> · </span>
            <span className="font-medium text-foreground/80">
              Billing cycle
            </span>{" "}
            <span>No subscription</span>
          </>
        ) : currentPlan === "free" ? (
          <>
            <span className="font-medium text-foreground/80">
              Billing cycle
            </span>{" "}
            <span className="capitalize">
              {billingStatus.billingInterval ?? "No subscription"}
            </span>
          </>
        ) : (
          <>
            <span className="font-medium text-foreground/80">
              Subscription status
            </span>{" "}
            <span className="capitalize">{subscriptionStatusLabel}</span>
            <span className="text-muted-foreground/70"> · </span>
            <span className="font-medium text-foreground/80">
              Billing cycle
            </span>{" "}
            <span className="capitalize">
              {billingStatus.billingInterval ?? "No subscription"}
            </span>
          </>
        )}
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge
          variant="secondary"
          className="rounded-md px-2.5 py-0.5 text-xs font-medium"
        >
          Current
        </Badge>
        <span
          className="text-sm text-muted-foreground"
          data-testid="current-plan-renewal"
        >
          {isTrial
            ? `Trial ends ${formattedTrialEnd}`
            : getCurrentPlanRenewalLine(billingStatus, formattedPeriodEnd)}
        </span>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="flex min-w-0 flex-1 gap-4">
          <div
            className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-[linear-gradient(to_right,hsl(var(--border)/0.35)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--border)/0.35)_1px,transparent_1px)] bg-[size:10px_10px] bg-muted/40"
            aria-hidden
          >
            <Box className="size-6 text-primary" />
          </div>
          <div className="min-w-0 space-y-1.5">
            <p className="text-2xl font-semibold tracking-tight text-muted-foreground">
              {isTrial
                ? `${formatPlanName(displayPlan)} Trial`
                : formatPlanName(displayPlan)}
            </p>
            {currentPlan === "free" && !isTrial ? (
              <p className="text-xs text-muted-foreground/90">
                Limited functionality
              </p>
            ) : null}
            {billingDetailLine ? (
              <p className="text-sm text-muted-foreground">
                {billingDetailLine}
                {showIntervalPortalLink ? (
                  <>
                    <span className="text-muted-foreground/70"> · </span>
                    <button
                      type="button"
                      className="font-medium text-primary underline-offset-4 hover:underline"
                      onClick={() => void onManageBilling()}
                      disabled={isOpeningPortal || !canManageBilling}
                    >
                      {effectiveBillingInterval === "annual"
                        ? "Change to monthly"
                        : "Change to annual"}
                    </button>
                  </>
                ) : null}
              </p>
            ) : isLoadingPlanCatalog ? (
              <p className="text-sm text-muted-foreground">
                Loading plan details…
              </p>
            ) : currentPlan !== "free" || isTrial ? (
              <p className="text-sm text-muted-foreground">
                Billing details are updating…
              </p>
            ) : null}
          </div>
        </div>

        {currentPlan !== "free" ? (
          <Button
            variant="outline"
            className="shrink-0 gap-2 self-start sm:self-center"
            onClick={() => void onManageBilling()}
            disabled={
              !canManageBilling || !billingConfigured || isOpeningPortal
            }
          >
            {isOpeningPortal ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Loading...
              </>
            ) : (
              <>
                <Pencil className="size-4" />
                Manage plan
              </>
            )}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
