import { useEffect, useState } from "react";
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

const PLAN_HIGHLIGHTS: Record<OrganizationPlan, string[]> = {
  free: [
    "Get started with small organizations",
    "Up to 5 members",
    "Up to 3 workspaces",
  ],
  starter: [
    "Generate Evals included",
    "Evals CI/CD included",
    "Sandboxes included",
  ],
  team: [
    "Everything in Starter",
    "Higher member and workspace limits",
    "Priority support",
  ],
  enterprise: [
    "Everything in Team",
    "Audit Log included",
    "SSO and bespoke support",
  ],
};

function getPlanRank(plan: OrganizationPlan): number {
  return PLAN_ORDER.indexOf(plan);
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

function getAnnualSavingsLabel(planCatalog: PlanCatalog | undefined): string {
  if (!planCatalog) {
    return "Save annually";
  }

  const starterPrices = planCatalog.plans.starter.prices;
  if (
    starterPrices.monthly == null ||
    starterPrices.annual == null ||
    starterPrices.monthly === 0
  ) {
    return "Save annually";
  }

  const annualizedMonthly = starterPrices.monthly * 12;
  const savings =
    ((annualizedMonthly - starterPrices.annual) / annualizedMonthly) * 100;
  return `Save ${Math.round(savings)}%`;
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
  const annualSavingsLabel = getAnnualSavingsLabel(planCatalog);
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

      <Card className="border-border/60">
        <CardHeader className="gap-4 md:flex-row md:items-center md:justify-between">
          <div className="space-y-1">
            <CardTitle className="text-lg">Choose an interval</CardTitle>
            <CardDescription>
              Annual billing lowers the effective monthly seat price.
            </CardDescription>
          </div>
          <div className="inline-flex rounded-lg border border-border/70 bg-muted/40 p-1">
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
            <button
              type="button"
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                billingInterval === "annual"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground",
              )}
              onClick={() => setBillingInterval("annual")}
            >
              Annual
              <span className="ml-2 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700">
                {annualSavingsLabel}
              </span>
            </button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoadingPlanCatalog || !planCatalog ? (
            <div className="rounded-md border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
              Loading plan catalog...
            </div>
          ) : (
            <div className="grid gap-4 xl:grid-cols-4">
              {PLAN_ORDER.map((plan) => {
                const entry = planCatalog.plans[plan];
                const isCurrentPlan = currentPlan === plan;
                const isHigherTier =
                  getPlanRank(plan) > getPlanRank(currentPlan);
                const isDowngrade =
                  getPlanRank(plan) < getPlanRank(currentPlan);
                const priceLabel =
                  plan === "enterprise"
                    ? "Custom"
                    : plan === "free"
                      ? "$0"
                      : formatPrice(
                          entry.prices[billingInterval],
                          planCatalog.currency,
                          billingInterval,
                        );
                const priceDetail =
                  plan === "enterprise"
                    ? "Contact us"
                    : plan === "free"
                      ? "No credit card required"
                      : formatPriceDetail(
                          entry.prices[billingInterval],
                          planCatalog.currency,
                          billingInterval,
                        );

                let ctaLabel = "Current plan";
                let ctaDisabled = true;
                let ctaVariant: "default" | "outline" | "secondary" = "outline";
                let ctaAction: (() => void) | undefined;

                if (isCurrentPlan) {
                  ctaLabel = "Current plan";
                } else if (plan === "enterprise") {
                  ctaLabel = "Contact us";
                  ctaDisabled = false;
                  ctaVariant = "secondary";
                  ctaAction = () => {
                    window.location.href =
                      "mailto:founders@mcpjam.com?subject=MCPJam%20Enterprise";
                  };
                } else if (plan === "free" || isDowngrade) {
                  ctaLabel = "Downgrade unavailable";
                } else if (isHigherTier && entry.isSelfServe) {
                  ctaLabel = "Upgrade";
                  ctaDisabled = false;
                  ctaVariant = "default";
                  ctaAction = () => {
                    void onStartCheckout(plan, billingInterval);
                  };
                }

                if (!billingConfigured || !canManageBilling) {
                  ctaDisabled = true;
                }

                return (
                  <Card
                    key={plan}
                    className={cn(
                      "relative h-full min-h-0 min-w-0 gap-4 border-border/60 py-5",
                      isCurrentPlan && "border-primary/50 shadow-md",
                    )}
                  >
                    <CardHeader className="min-w-0 shrink-0 space-y-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <CardTitle className="min-w-0 break-words">
                            {entry.displayName}
                          </CardTitle>
                          {isCurrentPlan ? (
                            <Badge variant="outline">Current</Badge>
                          ) : null}
                        </div>
                        <CardDescription>
                          {PLAN_HIGHLIGHTS[plan][0]}
                        </CardDescription>
                      </div>
                      <div className="min-w-0 space-y-1">
                        <PlanPriceDisplay label={priceLabel} />
                        <p className="text-sm text-muted-foreground">
                          {priceDetail}
                        </p>
                      </div>
                    </CardHeader>
                    <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
                      <ul className="space-y-2 text-sm text-muted-foreground">
                        {PLAN_HIGHLIGHTS[plan].slice(1).map((highlight) => (
                          <li
                            key={highlight}
                            className="flex items-start gap-2"
                          >
                            <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                            <span>{highlight}</span>
                          </li>
                        ))}
                      </ul>
                      <Button
                        className="mt-auto w-full"
                        variant={ctaVariant}
                        disabled={ctaDisabled || isBillingActionPending}
                        onClick={ctaAction}
                      >
                        {isBillingActionPending && ctaAction ? (
                          <>
                            <Loader2 className="size-4 animate-spin" />
                            Loading...
                          </>
                        ) : (
                          ctaLabel
                        )}
                      </Button>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {!isLoadingPlanCatalog && planCatalog ? (
        <Card className="border-border/60">
          <CardHeader>
            <CardTitle className="text-lg">Included by plan</CardTitle>
            <CardDescription>
              The first in-app billing page focuses on what is currently gated
              in product and the limits that shape usage.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Feature</TableHead>
                  {PLAN_ORDER.map((plan) => (
                    <TableHead key={plan} className="text-center">
                      {planCatalog.plans[plan].displayName}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {FEATURE_ROWS.map((feature) => (
                  <TableRow key={feature}>
                    <TableCell className="font-medium">
                      {formatBillingFeatureName(feature)}
                    </TableCell>
                    {PLAN_ORDER.map((plan) => (
                      <TableCell
                        key={`${feature}-${plan}`}
                        className="text-center"
                      >
                        <FeatureAvailability
                          included={planCatalog.plans[plan].features[feature]}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {LIMIT_ROWS.map((limit) => (
                  <TableRow key={limit.key}>
                    <TableCell className="font-medium">{limit.label}</TableCell>
                    {PLAN_ORDER.map((plan) => (
                      <TableCell
                        key={`${limit.key}-${plan}`}
                        className="text-center"
                      >
                        {formatLimitValue(
                          planCatalog.plans[plan].limits[limit.key],
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
