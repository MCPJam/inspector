import { Box, Loader2, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  BillingInterval,
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

function formatBillingDate(timestampMs: number | null): string {
  if (timestampMs == null) {
    return "Not available";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestampMs));
}

function getScheduledCancellationDateMs(
  billingStatus: OrganizationBillingStatus,
): number | null {
  if (!billingStatus.stripeCancelAtPeriodEnd) {
    return null;
  }

  return billingStatus.stripeCancelAt ?? billingStatus.stripeCurrentPeriodEnd;
}

function getScheduledChangeDateMs(
  billingStatus: OrganizationBillingStatus,
): number | null {
  if (
    billingStatus.stripeScheduledPlan == null ||
    billingStatus.stripeScheduledBillingInterval == null
  ) {
    return null;
  }

  return billingStatus.stripeScheduledEffectiveAt;
}

export function getCurrentPlanRenewalLine(
  billingStatus: OrganizationBillingStatus,
  formattedPeriodEnd: string,
  formattedCancellationDate: string,
  formattedScheduledChangeDate: string,
): string {
  if (billingStatus.stripeCancelAtPeriodEnd) {
    return formattedCancellationDate === "Not available"
      ? "Will not renew"
      : `Cancels ${formattedCancellationDate}`;
  }
  if (
    billingStatus.stripeScheduledPlan != null &&
    billingStatus.stripeScheduledBillingInterval != null
  ) {
    return formattedScheduledChangeDate === "Not available"
      ? "Scheduled change pending"
      : `Changes ${formattedScheduledChangeDate}`;
  }
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

function getScheduledCancellationDetailLine(
  billingStatus: OrganizationBillingStatus,
  formattedCancellationDate: string,
): string | null {
  if (!billingStatus.stripeCancelAtPeriodEnd) {
    return null;
  }

  if (formattedCancellationDate === "Not available") {
    return "Service ends at the end of the current billing period. Will not renew.";
  }

  return `Service ends ${formattedCancellationDate}. Will not renew.`;
}

function getScheduledChangeDetailLine(
  billingStatus: OrganizationBillingStatus,
  formattedScheduledChangeDate: string,
): string | null {
  const scheduledPlan = billingStatus.stripeScheduledPlan;
  const scheduledBillingInterval = billingStatus.stripeScheduledBillingInterval;

  if (!scheduledPlan || !scheduledBillingInterval) {
    return null;
  }

  const planPrefix =
    scheduledPlan === billingStatus.plan
      ? ""
      : `${formatPlanName(scheduledPlan)} `;
  const currentIntervalLabel =
    billingStatus.billingInterval === "annual" ? "annual" : "monthly";
  const currentPlanDescriptor = `${formatPlanName(billingStatus.plan)} ${currentIntervalLabel}`;
  const cadenceLabel =
    scheduledBillingInterval === "annual"
      ? "Annual billing"
      : "Monthly billing";
  const subject = planPrefix
    ? `${planPrefix}${scheduledBillingInterval}`
    : cadenceLabel;

  if (formattedScheduledChangeDate === "Not available") {
    return scheduledPlan === billingStatus.plan
      ? `${subject} starts at the end of the current billing period.`
      : `${subject} starts at the end of the current billing period. ${currentPlanDescriptor} remains active until then.`;
  }

  return scheduledPlan === billingStatus.plan
    ? `${subject} starts ${formattedScheduledChangeDate}.`
    : `${subject} starts ${formattedScheduledChangeDate}. ${currentPlanDescriptor} remains active until then.`;
}

function formatCurrentPlanBillingDetailLine(
  billingStatus: OrganizationBillingStatus,
  planCatalog: PlanCatalog,
): string | null {
  if (billingStatus.source === "trial") {
    return "7-day trial · no active subscription yet";
  }
  if (billingStatus.source === "simulation") {
    return "Simulation active · billing changes are not applied";
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
  onChangeBillingInterval: (
    targetBillingInterval: BillingInterval,
  ) => Promise<void>;
  onCancelScheduledBillingChange?: () => void;
  cancelScheduledBillingChangeLabel?: string | null;
  onManageBilling: () => Promise<void>;
  isOpeningPortal: boolean;
}

export function OrganizationCurrentPlanPanel({
  billingStatus,
  planCatalog,
  isLoadingPlanCatalog,
  onChangeBillingInterval,
  onCancelScheduledBillingChange,
  cancelScheduledBillingChangeLabel,
  onManageBilling,
  isOpeningPortal,
}: OrganizationCurrentPlanPanelProps) {
  const currentPlan = billingStatus.plan ?? "free";
  const isTrial = billingStatus.source === "trial";
  const isSimulation = billingStatus.source === "simulation";
  const displayPlan = isTrial
    ? (billingStatus.trialPlan ?? billingStatus.effectivePlan)
    : isSimulation
      ? billingStatus.effectivePlan
      : currentPlan;
  const billingConfigured = billingStatus.billingConfigured ?? false;
  const canManageBilling = billingStatus.canManageBilling ?? false;
  const formattedPeriodEnd = formatBillingDate(
    billingStatus.stripeCurrentPeriodEnd,
  );
  const scheduledCancellationDate = formatBillingDate(
    getScheduledCancellationDateMs(billingStatus),
  );
  const scheduledChangeDate = formatBillingDate(
    getScheduledChangeDateMs(billingStatus),
  );
  const subscriptionStatusLabel = billingStatus.subscriptionStatus
    ? billingStatus.subscriptionStatus.replace(/_/g, " ")
    : "Not subscribed";
  const formattedTrialEnd = formatBillingDate(billingStatus.trialEndsAt);

  const effectiveBillingInterval = billingStatus.billingInterval ?? "monthly";
  const targetBillingInterval: BillingInterval =
    effectiveBillingInterval === "annual" ? "monthly" : "annual";
  const billingDetailLine = planCatalog
    ? formatCurrentPlanBillingDetailLine(billingStatus, planCatalog)
    : null;
  const scheduledCancellationDetailLine = getScheduledCancellationDetailLine(
    billingStatus,
    scheduledCancellationDate,
  );
  const scheduledChangeDetailLine = getScheduledChangeDetailLine(
    billingStatus,
    scheduledChangeDate,
  );
  const simulationBanner = isSimulation
    ? `Simulation active. Limits and access use ${formatPlanName(displayPlan)}, while billing remains on ${formatPlanName(currentPlan)}.`
    : null;

  const showIntervalPortalLink =
    billingConfigured &&
    canManageBilling &&
    !isTrial &&
    (currentPlan === "starter" || currentPlan === "team") &&
    billingStatus.billingInterval != null &&
    scheduledChangeDetailLine == null &&
    !billingStatus.stripeCancelAtPeriodEnd;
  const showCancelScheduledBillingChangeLink =
    scheduledChangeDetailLine != null &&
    !!cancelScheduledBillingChangeLabel &&
    !!onCancelScheduledBillingChange &&
    canManageBilling;

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border/70 bg-muted/20 p-5 md:p-6">
      <p className="text-xs text-muted-foreground">
        {isTrial ? (
          <>
            <span className="font-medium text-foreground/80">Trial status</span>{" "}
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

      {isSimulation ? (
        <div
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-950 dark:text-amber-100"
          data-testid="current-plan-simulation-banner"
        >
          {simulationBanner}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge
          variant="secondary"
          className="rounded-md px-2.5 py-0.5 text-xs font-medium"
        >
          Current
        </Badge>
        {billingStatus.stripeCancelAtPeriodEnd ? (
          <Badge
            variant="outline"
            className="rounded-md border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-900 dark:text-amber-100"
            data-testid="current-plan-non-renewing-badge"
          >
            Will not renew
          </Badge>
        ) : null}
        <span
          className="text-sm text-muted-foreground"
          data-testid="current-plan-renewal"
        >
          {isTrial
            ? `Trial ends ${formattedTrialEnd}`
            : getCurrentPlanRenewalLine(
                billingStatus,
                formattedPeriodEnd,
                scheduledCancellationDate,
                scheduledChangeDate,
              )}
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
            {displayPlan === "free" && !isTrial ? (
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
                      onClick={() =>
                        void onChangeBillingInterval(targetBillingInterval)
                      }
                      disabled={isOpeningPortal || !canManageBilling}
                    >
                      {targetBillingInterval === "monthly"
                        ? "Change to monthly"
                        : "Change to annual"}
                    </button>
                  </>
                ) : null}
              </p>
            ) : null}
            {scheduledCancellationDetailLine ? (
              <p
                className="text-xs font-medium text-amber-900 dark:text-amber-100"
                data-testid="current-plan-scheduled-cancel"
              >
                {scheduledCancellationDetailLine}
              </p>
            ) : scheduledChangeDetailLine ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p
                  className="text-xs font-medium text-muted-foreground"
                  data-testid="current-plan-scheduled-change"
                >
                  {scheduledChangeDetailLine}
                </p>
                {showCancelScheduledBillingChangeLink ? (
                  <button
                    type="button"
                    className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                    onClick={() => onCancelScheduledBillingChange?.()}
                  >
                    {cancelScheduledBillingChangeLabel}
                  </button>
                ) : null}
              </div>
            ) : isLoadingPlanCatalog ? (
              <p className="text-sm text-muted-foreground">
                Loading plan details…
              </p>
            ) : !billingDetailLine && (currentPlan !== "free" || isTrial) ? (
              <p className="text-sm text-muted-foreground">
                Billing details are updating…
              </p>
            ) : null}
          </div>
        </div>

        {currentPlan !== "free" && canManageBilling ? (
          <Button
            variant="outline"
            className="shrink-0 gap-2 self-start sm:self-center"
            onClick={() => void onManageBilling()}
            disabled={!billingConfigured || isOpeningPortal}
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
