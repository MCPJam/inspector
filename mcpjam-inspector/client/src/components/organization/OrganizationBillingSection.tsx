import { Fragment, useEffect, useState } from "react";
import { Check, CreditCard, Loader2, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  BillingFeatureName,
  BillingInterval,
  BillingLimitName,
  OrganizationBillingStatus,
  OrganizationPlan,
  PlanCatalog,
} from "@/hooks/useOrganizationBilling";
import {
  formatBillingFeatureName,
  formatPlanName,
} from "@/lib/billing-entitlements";
import { cn } from "@/lib/utils";

const PLAN_ORDER: OrganizationPlan[] = [
  "free",
  "starter",
  "team",
  "enterprise",
];

const FEATURE_ROWS: BillingFeatureName[] = [
  "evals",
  "cicd",
  "sandboxes",
  "auditLog",
];

const LIMIT_ROWS: Array<{ key: BillingLimitName; label: string }> = [
  { key: "maxMembers", label: "Members" },
  { key: "maxSandboxesPerWorkspace", label: "Sandboxes / workspace" },
  { key: "maxEvalRunsPerMonth", label: "Eval runs / month" },
];

/** Column highlighted as the recommended tier (matches common pricing-page “Popular”). */
const POPULAR_PLAN: OrganizationPlan = "team";

const COMPARE_SECTIONS: Array<{
  title: string;
  rows: Array<
    | { type: "feature"; key: BillingFeatureName }
    | { type: "limit"; key: BillingLimitName; label: string }
  >;
}> = [
  {
    title: "Product access",
    rows: FEATURE_ROWS.map((key) => ({ type: "feature" as const, key })),
  },
  {
    title: "Usage limits",
    rows: LIMIT_ROWS.map(({ key, label }) => ({
      type: "limit" as const,
      key,
      label,
    })),
  },
];

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
  onManageBilling: () => Promise<void>;
  onStartCheckout: (
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
    onManageBilling,
    onStartCheckout,
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
      onClick: () => void onManageBilling(),
    };
  }

  if (isHigherTier && entry.isSelfServe) {
    return {
      label: "Upgrade",
      disabled:
        !billingConfigured ||
        !canManageBilling ||
        isBillingActionPending,
      variant: "default",
      onClick: () => void onStartCheckout(plan, billingInterval),
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

function formatPrice(
  amountInCents: number | null,
  currency: string,
  interval: BillingInterval,
): string {
  if (amountInCents == null) {
    return interval === "annual" ? "Custom annual" : "Custom pricing";
  }

  if (interval === "monthly") {
    return `${formatCurrency(amountInCents / 100, currency, 0)}/seat/mo`;
  }

  const monthlyEquivalent = amountInCents / 12 / 100;
  return `${formatCurrency(monthlyEquivalent, currency, 2)}/seat/mo`;
}

function formatPriceDetail(
  amountInCents: number | null,
  currency: string,
  interval: BillingInterval,
): string {
  if (amountInCents == null) {
    return "Sales-led";
  }

  if (interval === "monthly") {
    return "Billed monthly";
  }

  return `${formatCurrency(amountInCents / 100, currency, 0)} billed annually`;
}

function formatPerSeatCadence(
  plan: OrganizationPlan,
  interval: BillingInterval,
): string {
  if (plan === "free") {
    return "Per seat, billed monthly";
  }
  if (plan === "enterprise") {
    return "Annual commitment";
  }
  return interval === "annual"
    ? "Per seat, billed annually"
    : "Per seat, billed monthly";
}

function formatLimitValue(value: number | null): string {
  if (value === null) {
    return "Unlimited";
  }

  return value.toLocaleString();
}

const PER_SEAT_MO_SUFFIX = "/seat/mo";

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

  return (
    <p className="min-w-0 text-3xl font-semibold tabular-nums tracking-tight">
      {label}
    </p>
  );
}

function getAnnualDiscountPercent(planCatalog: PlanCatalog | undefined): number | null {
  if (!planCatalog) {
    return null;
  }
  const starterPrices = planCatalog.plans.starter.prices;
  if (
    starterPrices.monthly == null ||
    starterPrices.annual == null ||
    starterPrices.monthly === 0
  ) {
    return null;
  }
  const annualizedMonthly = starterPrices.monthly * 12;
  return Math.round(
    ((annualizedMonthly - starterPrices.annual) / annualizedMonthly) * 100,
  );
}

function FeatureAvailability({ included }: { included: boolean }) {
  return included ? (
    <span className="inline-flex items-center gap-1 text-sm font-medium text-foreground">
      <Check className="size-4 text-emerald-600" />
      Included
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
      <Minus className="size-4" />
      Not included
    </span>
  );
}

interface OrganizationBillingSectionProps {
  billingStatus: OrganizationBillingStatus | undefined;
  organizationName: string;
  planCatalog: PlanCatalog | undefined;
  isLoadingBilling: boolean;
  isLoadingPlanCatalog: boolean;
  isStartingCheckout: boolean;
  isOpeningPortal: boolean;
  onManageBilling: () => Promise<void>;
  onStartCheckout: (
    plan: "starter" | "team",
    billingInterval: BillingInterval,
  ) => Promise<void>;
}

export function OrganizationBillingSection({
  billingStatus,
  organizationName,
  planCatalog,
  isLoadingBilling,
  isLoadingPlanCatalog,
  isStartingCheckout,
  isOpeningPortal,
  onManageBilling,
  onStartCheckout,
}: OrganizationBillingSectionProps) {
  const [billingInterval, setBillingInterval] =
    useState<BillingInterval>("monthly");

  useEffect(() => {
    if (billingStatus?.billingInterval === "annual") {
      setBillingInterval((current) =>
        current === "monthly" ? "annual" : current,
      );
    }
  }, [billingStatus?.billingInterval]);

  const currentPlan = billingStatus?.plan ?? "free";
  const billingConfigured = billingStatus?.billingConfigured ?? false;
  const canManageBilling = billingStatus?.canManageBilling ?? false;
  const isBillingActionPending = isStartingCheckout || isOpeningPortal;
  const annualDiscountPct = getAnnualDiscountPercent(planCatalog);
  const formattedPeriodEnd =
    billingStatus?.stripeCurrentPeriodEnd != null
      ? new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        }).format(new Date(billingStatus.stripeCurrentPeriodEnd))
      : "Not available";
  const subscriptionStatusLabel = billingStatus?.subscriptionStatus
    ? billingStatus.subscriptionStatus.replace(/_/g, " ")
    : "Not subscribed";

  return (
    <div className="space-y-5">
      <Card className="border-border/60">
        <CardHeader className="gap-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-xl">
              <CreditCard className="size-4 text-muted-foreground" />
              Plans & Billing
            </CardTitle>
            <CardDescription>
              Compare plans, review your current subscription, and start billing
              changes for {organizationName}.
            </CardDescription>
          </div>
          {billingStatus && currentPlan !== "free" ? (
            <Button
              variant="outline"
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
                "Manage subscription"
              )}
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoadingBilling ? (
            <div className="rounded-md border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
              Loading billing details...
            </div>
          ) : billingStatus ? (
            <>
              <div className="grid gap-3 rounded-md border border-border/70 p-4 sm:grid-cols-2 xl:grid-cols-4">
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Current plan
                  </p>
                  <p className="text-sm font-medium">
                    {formatPlanName(currentPlan)}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Subscription status
                  </p>
                  <p className="text-sm font-medium capitalize">
                    {subscriptionStatusLabel}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Billing cycle
                  </p>
                  <p className="text-sm font-medium capitalize">
                    {billingStatus.billingInterval ?? "No subscription"}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Current period ends
                  </p>
                  <p className="text-sm font-medium">{formattedPeriodEnd}</p>
                </div>
              </div>
              {!billingConfigured ? (
                <div className="rounded-md border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
                  Billing is not configured in this environment. Plans are
                  visible, but purchase actions are unavailable.
                </div>
              ) : null}
              {!canManageBilling ? (
                <p className="text-sm text-muted-foreground">
                  Only organization owners can manage billing changes. Admins
                  can review plan details here.
                </p>
              ) : null}
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card className="border-border/60 py-6 shadow-sm">
        <CardHeader className="gap-4 border-b border-border/60 px-4 pb-6 sm:px-6 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">
              Compare plans
            </p>
            <CardTitle className="text-xl">
              Find the right plan for your team
            </CardTitle>
            <CardDescription>
              Same matrix as the MCPJam marketing pricing page — limits and
              commercial packaging at a glance.
            </CardDescription>
          </div>
          <div className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-muted/40 p-1">
            <button
              type="button"
              className={cn(
                "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                billingInterval === "annual"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground",
              )}
              onClick={() => setBillingInterval("annual")}
            >
              Annual
              {annualDiscountPct != null ? (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                  -{annualDiscountPct}%
                </span>
              ) : null}
            </button>
            <button
              type="button"
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                billingInterval === "monthly"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground",
              )}
              onClick={() => setBillingInterval("monthly")}
            >
              Monthly
            </button>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0 pt-0">
          {isLoadingPlanCatalog || !planCatalog ? (
            <div className="px-4 py-6 sm:px-6">
              <div className="rounded-md border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
                Loading plan catalog...
              </div>
            </div>
          ) : (
            <div className="relative w-full overflow-x-auto">
              <div className="min-w-[56rem] px-4 pb-6 sm:px-6">
                <Table>
                  <TableHeader>
                    <TableRow className="border-b hover:bg-transparent">
                      <TableHead className="sticky left-0 z-20 w-[26%] min-w-[11rem] bg-card align-top shadow-[1px_0_0_0_hsl(var(--border))]">
                        <span className="sr-only">Features</span>
                      </TableHead>
                      {PLAN_ORDER.map((plan) => {
                        const entry = planCatalog.plans[plan];
                        const isEnterprisePlan = plan === "enterprise";
                        const priceLabel = isEnterprisePlan
                          ? "Custom"
                          : plan === "free"
                            ? "$0"
                            : formatPrice(
                                entry.prices[billingInterval],
                                planCatalog.currency,
                                billingInterval,
                              );
                        const priceSubtext = isEnterprisePlan
                          ? formatPerSeatCadence(plan, billingInterval)
                          : plan === "free"
                            ? "No credit card required"
                            : formatPerSeatCadence(plan, billingInterval);
                        const cta = getPlanColumnCta({
                          plan,
                          currentPlan,
                          entry,
                          billingConfigured,
                          canManageBilling,
                          isBillingActionPending,
                          onManageBilling,
                          onStartCheckout,
                          billingInterval,
                        });
                        const isPopular = plan === POPULAR_PLAN;
                        return (
                          <TableHead
                            key={plan}
                            className={cn(
                              "align-top px-3 pb-4 pt-5 text-center",
                              isPopular &&
                                "border-x border-primary/35 bg-primary/[0.06]",
                            )}
                          >
                            <div className="mx-auto flex max-w-[13rem] flex-col items-center gap-3">
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
                              </div>
                              <Button
                                className="w-full rounded-lg"
                                size="sm"
                                variant={cta.variant}
                                disabled={cta.disabled}
                                onClick={cta.onClick}
                              >
                                {isBillingActionPending && cta.onClick ? (
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
                    {COMPARE_SECTIONS.map((section) => (
                      <Fragment key={section.title}>
                        <TableRow className="border-b hover:bg-transparent">
                          <TableCell
                            className="bg-muted/40 py-2.5 pl-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                            colSpan={PLAN_ORDER.length + 1}
                          >
                            {section.title}
                          </TableCell>
                        </TableRow>
                        {section.rows.map((row) => (
                          <TableRow
                            key={
                              row.type === "feature"
                                ? row.key
                                : `${row.key}-${row.label}`
                            }
                            className="border-b"
                          >
                            <TableCell className="sticky left-0 z-10 bg-card py-3 pl-4 text-sm font-medium shadow-[1px_0_0_0_hsl(var(--border))]">
                              {row.type === "feature"
                                ? formatBillingFeatureName(row.key)
                                : row.label}
                            </TableCell>
                            {PLAN_ORDER.map((plan) => {
                              const isPopular = plan === POPULAR_PLAN;
                              return (
                                <TableCell
                                  key={plan}
                                  className={cn(
                                    "px-3 py-3 text-center text-sm",
                                    isPopular &&
                                      "border-x border-primary/35 bg-primary/[0.06]",
                                  )}
                                >
                                  {row.type === "feature" ? (
                                    <FeatureAvailability
                                      included={
                                        planCatalog.plans[plan].features[
                                          row.key
                                        ]
                                      }
                                    />
                                  ) : (
                                    formatLimitValue(
                                      planCatalog.plans[plan].limits[row.key],
                                    )
                                  )}
                                </TableCell>
                              );
                            })}
                          </TableRow>
                        ))}
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
