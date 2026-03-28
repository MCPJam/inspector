import { Fragment, useEffect, useState } from "react";
import { Check, CreditCard, Loader2, Plus, X } from "lucide-react";
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
  BillingInterval,
  OrganizationBillingStatus,
  OrganizationPlan,
  PlanCatalog,
} from "@/hooks/useOrganizationBilling";
import {
  formatPlanName,
  getDisplayPriceCentsForPlan,
} from "@/lib/billing-entitlements";
import { cn } from "@/lib/utils";

const PLAN_ORDER: OrganizationPlan[] = [
  "free",
  "starter",
  "team",
  "enterprise",
];

/** Static compare matrix — mirrors mcpjam_pricing_page.html "Compare Plans" section. */
type CompareCell = "check" | "x" | string;

type CompareRowDef = { feature: string; cells: CompareCell[] };

type CompareCategoryDef = { title: string; rows: CompareRowDef[] };

const COMPARE_PLAN_CATEGORIES: CompareCategoryDef[] = [
  {
    title: "Testing & CI/CD",
    rows: [
      {
        feature: "Evals CI/CD runs",
        cells: ["5 / mo", "500 included", "5,000 included", "Custom volume"],
      },
      {
        feature: "CI/CD overage",
        cells: ["Hard cap", "$0.02 / run", "$0.015 / run", "$0.01 / run"],
      },
      {
        feature: "Cloud test runners",
        cells: ["check", "check", "check", "check"],
      },
      {
        feature: "Sandbox environments",
        cells: ["x", "1 environment", "5 environments", "Dedicated infra"],
      },
      {
        feature: "Sandbox hours",
        cells: ["x", "20 hrs included", "Unlimited", "Unlimited"],
      },
      {
        feature: "Isolated test environments",
        cells: ["x", "x", "check", "check"],
      },
    ],
  },
  {
    title: "LLM Playground",
    rows: [
      {
        feature: "Open models",
        cells: ["Rate limited", "check", "check", "check"],
      },
      {
        feature: "Frontier models",
        cells: ["x", "x", "check", "check"],
      },
      {
        feature: "Token budget / seat",
        cells: ["x", "$10 / mo", "$25 / seat / mo", "Custom commit"],
      },
      {
        feature: "Token overage",
        cells: ["x", "Cost + 30%", "Cost + 20%", "Negotiated"],
      },
    ],
  },
  {
    title: "Platform & Infrastructure",
    rows: [
      {
        feature: "Users",
        cells: ["1", "Up to 3", "Unlimited", "Unlimited"],
      },
      {
        feature: "Internal server registry",
        cells: ["x", "10 entries", "50 entries", "Unlimited"],
      },
      {
        feature: "Analytics",
        cells: ["x", "Basic", "Full", "Full + reporting"],
      },
      {
        feature: "Team management",
        cells: ["x", "x", "check", "check"],
      },
      {
        feature: "API access",
        cells: ["x", "x", "x", "check"],
      },
    ],
  },
  {
    title: "Security & Compliance",
    rows: [
      {
        feature: "SSO",
        cells: ["x", "x", "check", "check"],
      },
      {
        feature: "SCIM provisioning",
        cells: ["x", "x", "x", "check"],
      },
      {
        feature: "RBAC",
        cells: ["x", "x", "Basic", "Advanced"],
      },
      {
        feature: "Audit logs",
        cells: ["x", "x", "x", "check"],
      },
      {
        feature: "Data residency",
        cells: ["x", "x", "x", "check"],
      },
      {
        feature: "Dedicated support",
        cells: ["x", "x", "x", "check"],
      },
    ],
  },
];

const PLAN_TIER_BADGE: Record<
  OrganizationPlan,
  { label: string; variant?: "secondary" | "outline" | "default" }
> = {
  free: { label: "Community", variant: "secondary" },
  starter: { label: "Solo", variant: "secondary" },
  team: { label: "Popular", variant: "default" },
  enterprise: { label: "Enterprise", variant: "outline" },
};

const PLAN_HIGHLIGHTS: Record<OrganizationPlan, string[]> = {
  free: [
    "For builders getting started with MCP testing.",
    "Open Source on GitHub",
    "MCP Apps / ChatGPT Apps Builder",
    "LLM playground with open models",
    "Visual OAuth Debugger",
    "Testing MCP Primitives",
    "MCP Unit Tests and Evals UI",
    "JSON-RPC Logger & SDK",
    "Limited CI/CD eval runs",
  ],
  starter: [
    "For devs and small teams shipping MCP servers professionally.",
    "CI/CD runs with overage",
    "1 sandbox environment",
    "LLM playground with limited token budget",
    "Up to 3 users",
    "Internal server registry",
    "Basic analytics",
  ],
  team: [
    "For teams testing, evaluating, and shipping production MCP servers.",
    "Higher CI/CD run limits",
    "Multiple sandbox environments",
    "Frontier models in LLM playground",
    "Full analytics & registry",
    "Unlimited users & team management",
    "SSO included",
  ],
  enterprise: [
    "For organizations shipping production MCP at scale with full compliance.",
    "Committed CI/CD volume pricing",
    "Dedicated sandbox infrastructure",
    "All LLM models, custom token commit",
    "SSO, SCIM, RBAC & audit logs",
    "Data residency & compliance",
    "Dedicated support channel",
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
  plan: OrganizationPlan,
  amountInCents: number | null,
  currency: string,
  interval: BillingInterval,
): string {
  if (amountInCents == null) {
    return "Custom";
  }

  if (plan === "starter") {
    if (interval === "monthly") {
      return `${formatCurrency(amountInCents / 100, currency, 0)}/mo`;
    }
    const monthlyEquivalent = amountInCents / 12 / 100;
    return `${formatCurrency(monthlyEquivalent, currency, 2)}/mo`;
  }

  if (interval === "monthly") {
    return `${formatCurrency(amountInCents / 100, currency, 0)}/seat/mo`;
  }

  const monthlyEquivalent = amountInCents / 12 / 100;
  return `${formatCurrency(monthlyEquivalent, currency, 2)}/seat/mo`;
}

function formatPriceDetail(
  plan: OrganizationPlan,
  amountInCents: number | null,
  currency: string,
  interval: BillingInterval,
): string {
  if (amountInCents == null) {
    return plan === "enterprise" ? "Annual commitment" : "Sales-led";
  }

  if (plan === "free") {
    return "No credit card required";
  }

  if (plan === "team") {
    if (interval === "monthly") {
      return "5 seat minimum · Billed monthly";
    }
    return "5 seat minimum · Billed annually";
  }

  if (interval === "monthly") {
    return "Billed monthly";
  }

  return `${formatCurrency(amountInCents / 100, currency, 0)} billed annually`;
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

function CompareMatrixCell({ value }: { value: CompareCell }) {
  if (value === "check") {
    return (
      <Check
        className="mx-auto size-4 text-emerald-600"
        aria-label="Included"
      />
    );
  }
  if (value === "x") {
    return <X className="mx-auto size-4 text-muted-foreground/55" aria-label="Not included" />;
  }
  return (
    <span className="text-center text-sm text-muted-foreground">{value}</span>
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
    useState<BillingInterval>("annual");

  useEffect(() => {
    const interval = billingStatus?.billingInterval;
    if (interval === "monthly" || interval === "annual") {
      setBillingInterval(interval);
    }
  }, [billingStatus?.billingInterval]);

  const persistedPlan = billingStatus?.plan ?? "free";
  const effectivePlan = billingStatus?.effectivePlan ?? persistedPlan;
  const currentPlan = effectivePlan;
  const planMismatch =
    billingStatus && billingStatus.effectivePlan !== billingStatus.plan;
  const billingConfigured = billingStatus?.billingConfigured ?? false;
  const canManageBilling = billingStatus?.canManageBilling ?? false;
  const isBillingActionPending = isStartingCheckout || isOpeningPortal;
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
              MCPJam plans and pricing
            </CardTitle>
            <CardDescription>
              Start free, scale as you grow. Pick the plan that fits your
              team&apos;s MCP testing workflow. Subscription details for{" "}
              {organizationName}.
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
              <div className="grid gap-3 rounded-md border border-border/70 p-4 sm:grid-cols-2 xl:grid-cols-5">
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Current plan
                  </p>
                  <p className="text-sm font-medium">
                    {formatPlanName(currentPlan)}
                  </p>
                  {planMismatch ? (
                    <p className="text-xs text-muted-foreground">
                      Subscription is {formatPlanName(persistedPlan)}; effective
                      access follows {formatPlanName(effectivePlan)}.
                    </p>
                  ) : null}
                </div>
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Source
                  </p>
                  <p className="text-sm font-medium capitalize">
                    {billingStatus.source.replace(/_/g, " ")}
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
              {billingStatus.trialStatus?.toLowerCase() === "active" &&
              typeof billingStatus.trialDaysRemaining === "number" ? (
                <div className="rounded-md border border-border/70 bg-muted/30 p-3 text-sm">
                  <span className="font-medium">Trial active</span>
                  {billingStatus.trialPlan ? (
                    <span className="text-muted-foreground">
                      {" "}
                      ({formatPlanName(billingStatus.trialPlan)})
                    </span>
                  ) : null}
                  : {billingStatus.trialDaysRemaining} day
                  {billingStatus.trialDaysRemaining === 1 ? "" : "s"} remaining
                  {billingStatus.trialEndsAt
                    ? ` · ends ${new Intl.DateTimeFormat(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      }).format(new Date(billingStatus.trialEndsAt))}`
                    : null}
                </div>
              ) : null}
              {billingStatus.trialStatus?.toLowerCase() === "expired" ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  Trial ended. Upgrade or choose the Free plan from the billing
                  prompt if required.
                </div>
              ) : null}
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
            <CardTitle className="text-lg">Choose billing interval</CardTitle>
            <CardDescription>
              Annual billing lowers the effective monthly price. About 20% off
              versus monthly for Starter and Team.
            </CardDescription>
          </div>
          <div className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-muted/40 p-1">
            <button
              type="button"
              aria-label="Annual billing, save 20%"
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                billingInterval === "annual"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground",
              )}
              onClick={() => setBillingInterval("annual")}
            >
              <span>Annual</span>
              <span className="ml-2 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700">
                Save 20%
              </span>
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
                const isEnterprisePlan = plan === "enterprise";
                const displayPriceCents = getDisplayPriceCentsForPlan(
                  plan,
                  billingInterval,
                  entry,
                );
                const priceLabel = isEnterprisePlan
                  ? "Custom"
                  : plan === "free"
                    ? "$0"
                    : formatPrice(
                        plan,
                        displayPriceCents,
                        planCatalog.currency,
                        billingInterval,
                      );
                const priceDetail = isEnterprisePlan
                  ? "Annual commitment"
                  : plan === "free"
                    ? "No credit card required"
                    : formatPriceDetail(
                        plan,
                        displayPriceCents,
                        planCatalog.currency,
                        billingInterval,
                      );

                let ctaLabel = "Current plan";
                let ctaDisabled = true;
                let ctaVariant: "default" | "outline" | "secondary" = "outline";
                let ctaAction: (() => void) | undefined;

                if (isCurrentPlan) {
                  ctaLabel = "Current plan";
                } else if (isEnterprisePlan) {
                  ctaLabel = "Request a demo";
                  ctaDisabled = false;
                  ctaVariant = "secondary";
                  ctaAction = () => {
                    window.location.href =
                      "mailto:founders@mcpjam.com?subject=MCPJam%20Enterprise%20demo";
                  };
                } else if (plan === "free" || isDowngrade) {
                  ctaLabel = "Downgrade unavailable";
                } else if (isHigherTier && entry.isSelfServe) {
                  ctaLabel =
                    plan === "team" ? "Start free trial" : "Get started";
                  ctaDisabled = false;
                  ctaVariant = "default";
                  ctaAction = () => {
                    void onStartCheckout(plan, billingInterval);
                  };
                }

                if (
                  !isEnterprisePlan &&
                  (!billingConfigured || !canManageBilling)
                ) {
                  ctaDisabled = true;
                }

                const tierBadge = PLAN_TIER_BADGE[plan];
                const highlights = PLAN_HIGHLIGHTS[plan];
                const [tagline, ...bullets] = highlights;

                return (
                  <Card
                    key={plan}
                    className={cn(
                      "relative h-full min-h-0 min-w-0 gap-4 border-border/60 py-5",
                      isCurrentPlan && "border-primary/50 shadow-md",
                      plan === "team" &&
                        "border-orange-500/45 shadow-sm ring-1 ring-orange-500/20",
                    )}
                  >
                    <CardHeader className="min-w-0 shrink-0 space-y-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <CardTitle className="min-w-0 break-words">
                            {entry.displayName}
                          </CardTitle>
                          {plan !== "enterprise" ? (
                            <Badge variant={tierBadge.variant}>
                              {tierBadge.label}
                            </Badge>
                          ) : null}
                          {isCurrentPlan ? (
                            <Badge variant="outline">Current</Badge>
                          ) : null}
                        </div>
                        <CardDescription>{tagline}</CardDescription>
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
                        {bullets.map((highlight) => {
                          const Icon = plan === "free" ? Check : Plus;
                          return (
                            <li
                              key={highlight}
                              className="flex items-start gap-2"
                            >
                              <Icon
                                className={cn(
                                  "mt-0.5 size-4 shrink-0",
                                  plan === "free"
                                    ? "text-emerald-600"
                                    : "text-orange-600",
                                )}
                              />
                              <span>{highlight}</span>
                            </li>
                          );
                        })}
                      </ul>
                      <Button
                        className={cn(
                          "mt-auto w-full",
                          plan === "team" &&
                            !isCurrentPlan &&
                            "bg-orange-600 hover:bg-orange-600/90",
                        )}
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
            <p className="text-xs font-semibold uppercase tracking-wider text-orange-600">
              Compare plans
            </p>
            <CardTitle className="text-lg">
              Find the right plan for your team
            </CardTitle>
            <CardDescription>
              Same plan matrix as the MCPJam marketing pricing page — limits and
              commercial packaging at a glance.
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[10rem]">Feature</TableHead>
                  {PLAN_ORDER.map((plan) => (
                    <TableHead key={plan} className="min-w-[6.5rem] text-center">
                      {planCatalog.plans[plan].displayName}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {COMPARE_PLAN_CATEGORIES.map((category) => (
                  <Fragment key={category.title}>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableCell
                        colSpan={5}
                        className="py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                      >
                        {category.title}
                      </TableCell>
                    </TableRow>
                    {category.rows.map((row) => (
                      <TableRow key={`${category.title}-${row.feature}`}>
                        <TableCell className="font-medium">
                          {row.feature}
                        </TableCell>
                        {row.cells.map((cell, i) => (
                          <TableCell key={i} className="text-center">
                            <CompareMatrixCell value={cell} />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
