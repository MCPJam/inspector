import {
  isV2PlanCatalog,
  isLegacyTeamEntry,
  PLAN_ORDER,
  offeredPlans,
  canCheckoutPlan,
  canCheckoutPlanEntry,
  formatCatalogPrice,
} from "@/lib/pricing-catalog";
import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  CreditCard,
  Info,
  Loader2,
  Minus,
} from "lucide-react";
import { toast } from "@/lib/toast";
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
import { getAnnualDiscountPercent } from "@/lib/billing-entitlements";
import { consumeUrlFlag } from "@/lib/url-flag";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { buildComparePlanSectionsFromCatalog } from "@/components/organization/billing-compare-view-model";
import { type ComparePlanCell } from "@/components/organization/compare-plan-marketing";
import { PlanChangeConfirmDialog } from "@/components/organization/PlanChangeConfirmDialog";
import { CreditBalanceCard } from "@/components/billing/CreditBalanceCard";
import { PaymentsHistorySection } from "@/components/billing/PaymentsHistorySection";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { ErrorCard } from "@/components/ui/error-card";
import { useCreditTopupReturnFlowBilling } from "@/hooks/useCreditTopupReturnFlow";

/** Column highlighted as the recommended tier (matches common pricing-page “Popular”). */
const POPULAR_PLAN: OrganizationPlan = "team";

/** Edges of the recommended column, which every cell in it carries. */
const POPULAR_COLUMN_BORDER = "border-x border-primary/35";

/**
 * Tint of the recommended column. On a cell that already has a background it
 * goes on an overlay instead: both are backgrounds, so tailwind-merge keeps
 * only the later one and the row's own background would be dropped.
 */
const POPULAR_COLUMN_TINT = "bg-primary/[0.06]";

const POPULAR_COLUMN_CLASS = `${POPULAR_COLUMN_BORDER} ${POPULAR_COLUMN_TINT}`;

/** The two column widths the table splits under `table-fixed`. */
const PLAN_COLUMNS_WIDTH_PCT = 74;
const LABEL_COLUMN_WIDTH_PCT = 100 - PLAN_COLUMNS_WIDTH_PCT;

/** Defines org as the billed scope for plans and limits (vs projects). */
const ORG_COMPARE_PLANS_NOTE = "Your organization is the billed unit.";

function getPlanRank(plan: OrganizationPlan): number {
  return PLAN_ORDER.indexOf(plan);
}

function getPlanColumnCta(params: {
  plan: OrganizationPlan;
  currentPlan: OrganizationPlan;
  currentCatalogPlanId?: string;
  entry: NonNullable<PlanCatalog["plans"][OrganizationPlan]>;
  billingConfigured: boolean;
  canManageBilling: boolean;
  isBillingActionPending: boolean;
  scheduledCancellationDate: string | null;
  onDowngradePlan: (
    plan: OrganizationPlan,
    billingInterval: BillingInterval,
  ) => void;
  /** Opens the confirmation step; checkout starts only once it is confirmed. */
  onStartPlanChange: (
    plan: "pro" | "team",
    billingInterval: BillingInterval,
  ) => void;
  billingInterval: BillingInterval;
}): {
  label: string;
  disabled: boolean;
  variant: "default" | "outline" | "secondary";
  onClick?: () => void;
  tooltip?: string;
  ariaLabel?: string;
} {
  const {
    plan,
    currentPlan,
    currentCatalogPlanId,
    entry,
    billingConfigured,
    canManageBilling,
    isBillingActionPending,
    scheduledCancellationDate,
    onDowngradePlan,
    onStartPlanChange,
    billingInterval,
  } = params;

  const isDifferentBundle = currentCatalogPlanId !== entry.catalogPlanId;
  const isCurrentPlan =
    currentPlan === plan && (!isDifferentBundle || plan === "free");
  const isHigherTier = getPlanRank(plan) > getPlanRank(currentPlan);
  const isDowngrade = getPlanRank(plan) < getPlanRank(currentPlan);
  const isEnterprisePlan = plan === "enterprise";

  if (isCurrentPlan) {
    return { label: "Current plan", disabled: true, variant: "outline" };
  }

  if (isEnterprisePlan) {
    return {
      label: "Contact us",
      disabled: false,
      variant: "outline",
      onClick: () => {
        window.location.href = "https://www.mcpjam.com/contact";
      },
    };
  }

  if (isDowngrade) {
    if (
      plan !== "free" &&
      ((plan !== "pro" && plan !== "team") ||
        !canCheckoutPlanEntry(entry, plan, billingInterval))
    ) {
      return { label: "Unavailable", disabled: true, variant: "outline" };
    }
    if (scheduledCancellationDate !== null) {
      return {
        label: "Scheduled",
        disabled: true,
        variant: "outline",
        // The visible label is shortened to fit the column; the date stays in
        // the accessible name rather than only in the hover tooltip.
        ariaLabel: scheduledCancellationDate
          ? `Downgrade scheduled for ${scheduledCancellationDate}`
          : "Downgrade scheduled",
        tooltip: scheduledCancellationDate
          ? `Your plan is already scheduled to return to Free on ${scheduledCancellationDate}.`
          : "Your plan is already scheduled to return to Free at the end of the current billing period.",
      };
    }
    return {
      label: "Downgrade",
      disabled:
        !canManageBilling || !billingConfigured || isBillingActionPending,
      variant: "outline",
      onClick: () => void onDowngradePlan(plan, billingInterval),
    };
  }

  if (
    (isHigherTier || (currentPlan === plan && isDifferentBundle)) &&
    entry.isSelfServe
  ) {
    if (
      (plan !== "team" && plan !== "pro") ||
      !canCheckoutPlanEntry(entry, plan, billingInterval)
    ) {
      return { label: "Unavailable", disabled: true, variant: "outline" };
    }
    return {
      label: currentPlan === plan ? "Change plan" : "Upgrade",
      disabled:
        !billingConfigured || !canManageBilling || isBillingActionPending,
      variant: "default",
      onClick: () => void onStartPlanChange(plan, billingInterval),
    };
  }

  return { label: "Unavailable", disabled: true, variant: "outline" };
}

function formatBillingDate(timestampMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestampMs));
}

function getDeferredTrialBillingCopy(
  billingStatus: OrganizationBillingStatus | undefined,
): string | null {
  const deferredTrialBillingStartsAt =
    billingStatus?.deferredTrialBillingStartsAt;
  if (typeof deferredTrialBillingStartsAt !== "number") {
    return null;
  }

  return `$0 today. First bill charged in advance on ${formatBillingDate(
    deferredTrialBillingStartsAt,
  )}.`;
}

function formatPerSeatCadence(
  plan: OrganizationPlan,
  entry: NonNullable<PlanCatalog["plans"][OrganizationPlan]>,
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
  return interval === "annual" ? "Billed annually" : "Billed monthly";
}

const PER_SEAT_MO_SUFFIX = "/seat/mo";
const PER_MO_SUFFIX = "/mo";

function PlanPriceDisplay({ label }: { label: string }) {
  const suffix = label.endsWith(PER_SEAT_MO_SUFFIX)
    ? PER_SEAT_MO_SUFFIX
    : label.endsWith(PER_MO_SUFFIX)
    ? PER_MO_SUFFIX
    : null;
  const amount = suffix ? label.slice(0, -suffix.length) : label;

  return (
    <div className="flex min-h-9 min-w-0 items-baseline justify-center gap-x-1">
      <span className="text-3xl font-semibold tabular-nums tracking-tight">
        {amount}
      </span>
      {suffix ? (
        <span className="text-sm font-medium text-muted-foreground">
          {suffix}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Chrome's built-in page translation swaps each text node for a `<font>`
 * wrapper holding the translation. React keeps a reference to the original
 * node, so removing a bare text child later throws NotFoundError from
 * `removeChild`. Keeping both branches inside an element means React only ever
 * removes elements, which the translator leaves where they are.
 */
function PlanCtaContent({
  showSpinner,
  label,
}: {
  showSpinner: boolean;
  label: string;
}) {
  if (showSpinner) {
    return (
      <>
        <Loader2 className="size-4 animate-spin" />
        <span>Loading...</span>
      </>
    );
  }

  return <span>{label}</span>;
}

const COMPARE_PLAN_ROW_LABEL_TOOLTIPS: Record<
  string,
  { ariaLabel: string; content: string; contentClassName?: string }
> = {
  "V2 included credits": {
    ariaLabel: "About included credits",
    content:
      "Credits cover usage across playground, chat, evals, swarms, and user testing. Free credits reset daily; Pro and Team include an organization-wide monthly allowance.",
  },
  "V2 SSO / SAML": {
    ariaLabel: "About SSO",
    content:
      "Single sign-on with SAML for your organization is available on Enterprise.",
  },
  "Included credits": {
    ariaLabel: "About included credits",
    content:
      "Credits cover usage across playground, chat, evals, swarms, and user testing. Free credits reset daily; Team credits are allocated per seat each month.",
    contentClassName: "max-w-[22rem]",
  },
  "Seat limit": {
    ariaLabel: "About seat limits",
    content:
      "You're charged only for active members. Pending invites are free until accepted.",
    contentClassName: "max-w-[18rem]",
  },
  "Eval iterations": {
    ariaLabel: "About eval iterations",
    content:
      "Suite and quick eval runs count toward your plan's iteration allowance. Free resets daily; Team resets monthly.",
    contentClassName: "max-w-[22rem]",
  },
  "Evaluation traces": {
    ariaLabel: "What are evaluation traces?",
    content:
      "Traces for evaluations: configured user prompts, tool execution, agent reasoning, errors, and latency breakdown for playground and CI/CD runs.",
    contentClassName: "max-w-[26rem]",
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
      "Basic Admin/Member-style access on Free and Team; customizable roles and fine-grained permissions on Enterprise.",
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

const V2_ROW_EXPLANATIONS: Record<string, string> = {
  "Included credits":
    "Credits cover usage across your organization. Free credits reset daily; paid plan credits renew monthly.",
  Seats: "The number of members who can collaborate in your organization.",
  BYOK: "Bring your own API keys to use your preferred model providers.",
  Playground:
    "Connect to an MCP server and interact with its tools, resources, and prompts.",
  "OAuth / XAA Debugger":
    "Inspect authentication flows and troubleshoot server connections.",
  "User Acceptance Testing":
    "Test your server with realistic user interactions.",
  Evaluations: "Run repeatable tests to evaluate your MCP server’s behavior.",
  "Eval history": "How long past evaluation results remain available.",
  "Triage Insights": "Review evaluation findings to investigate failures.",
  "Traces history": "How long recorded traces remain available for inspection.",
  "SSO / SAML": "Single sign-on with SAML is available on Enterprise.",
  "Role-based access control":
    "Control member permissions. Enterprise includes custom roles and SCIM provisioning.",
  "Data processing agreement":
    "Enterprise agreements cover how your organization’s data is processed.",
  "Uptime SLA":
    "Enterprise service agreements define availability commitments.",
  "Audit log retention":
    "Retain organization activity records under your Enterprise agreement.",
  "Auth forensics, SIEM reports":
    "Enterprise reporting supports authentication investigations and security monitoring.",
  "Support tier":
    "Choose the level of assistance your organization needs, from community to dedicated support.",
};

/**
 * Cells for a row whose content spans the whole table (section headers, expanded
 * detail). A single colSpan would cut the highlighted column, so the popular
 * plan keeps a cell of its own.
 */
function FullWidthRowCells({
  plans,
  className,
  children,
}: {
  plans: OrganizationPlan[];
  className?: string;
  children?: ReactNode;
}) {
  const popularIndex = plans.indexOf(POPULAR_PLAN);
  if (popularIndex < 0) {
    return (
      <TableCell colSpan={plans.length + 1} className={className}>
        {children}
      </TableCell>
    );
  }
  const trailing = plans.length - 1 - popularIndex;
  return (
    <>
      <TableCell colSpan={popularIndex + 1} className={className}>
        {children}
      </TableCell>
      <TableCell className={cn(className, "relative", POPULAR_COLUMN_BORDER)}>
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0",
            POPULAR_COLUMN_TINT,
          )}
        />
      </TableCell>
      {trailing > 0 ? (
        <TableCell colSpan={trailing} className={className} />
      ) : null}
    </>
  );
}

function V2ComparisonRow({
  row,
  plans,
}: {
  row: { label: string } & Partial<Record<OrganizationPlan, ComparePlanCell>>;
  plans: OrganizationPlan[];
}) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  return (
    <>
      <TableRow className="border-b hover:bg-transparent">
        <TableCell className="sticky left-0 z-10 whitespace-normal bg-card p-0 text-base font-normal">
          <button
            type="button"
            className="flex min-h-[62px] w-full items-center gap-3 rounded-sm px-3 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={expanded}
            aria-controls={detailId}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronDown
              aria-hidden
              className={cn(
                "size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none",
                expanded && "rotate-180",
              )}
            />
            {row.label}
          </button>
        </TableCell>
        {plans.map((plan) => (
          <TableCell
            key={plan}
            className={cn(
              "whitespace-normal px-3 py-4 text-center align-middle",
              plan === POPULAR_PLAN && POPULAR_COLUMN_CLASS,
            )}
          >
            <ComparePlanMatrixCell v2 cell={row[plan] ?? { kind: "x" }} />
          </TableCell>
        ))}
      </TableRow>
      <TableRow hidden={!expanded} className="border-b hover:bg-transparent">
        <FullWidthRowCells
          plans={plans}
          className="whitespace-normal px-10 py-4"
        >
          <p
            id={detailId}
            className="max-w-2xl text-sm leading-relaxed text-muted-foreground"
          >
            {V2_ROW_EXPLANATIONS[row.label]}
          </p>
        </FullWidthRowCells>
      </TableRow>
    </>
  );
}

const COMPARE_PLAN_PERIOD_SUFFIXES = ["/ seat / mo", "/ day", "/ mo"] as const;

function ComparePlanMatrixCell({
  cell,
  v2 = false,
}: {
  cell: ComparePlanCell;
  v2?: boolean;
}) {
  if (cell.kind === "check") {
    return (
      <span className="flex w-full justify-center">
        <Check
          className={cn(
            "shrink-0",
            v2 ? "size-5 text-primary" : "size-4 text-emerald-600",
          )}
          aria-hidden
        />
        <span className="sr-only">Included</span>
      </span>
    );
  }
  if (cell.kind === "x") {
    return (
      <span className="flex w-full justify-center text-sm text-muted-foreground/80">
        {v2 ? (
          <Minus className="size-5" aria-hidden />
        ) : (
          <span aria-hidden>-</span>
        )}
        <span className="sr-only">Not included</span>
      </span>
    );
  }

  const periodSuffix = COMPARE_PLAN_PERIOD_SUFFIXES.find((suffix) =>
    cell.text.endsWith(suffix),
  );
  if (periodSuffix) {
    const amount = cell.text.slice(0, -periodSuffix.length).trimEnd();
    return (
      <span className="flex w-full items-baseline justify-center gap-x-1 text-sm">
        <span className="font-semibold tabular-nums text-foreground">
          {amount}
        </span>
        <span className="font-normal text-muted-foreground">
          {periodSuffix}
        </span>
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
}: {
  billingInterval: BillingInterval;
  onBillingIntervalChange: (interval: BillingInterval) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Billing interval"
      className="relative inline-grid max-w-full grid-cols-2 items-center gap-1 rounded-lg border border-border/70 bg-muted/40 p-1 whitespace-nowrap"
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-1 bottom-1 left-1 w-[calc(50%-0.375rem)] rounded-md bg-secondary ring-1 ring-border shadow-sm transition-transform duration-150 ease-out motion-reduce:transition-none",
          billingInterval === "monthly" && "translate-x-[calc(100%+0.25rem)]",
        )}
      />
      <button
        type="button"
        className={cn(
          "relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1.5 text-sm font-medium transition-colors sm:gap-2 sm:px-3",
          billingInterval === "annual"
            ? "text-secondary-foreground"
            : "text-muted-foreground",
        )}
        aria-pressed={billingInterval === "annual"}
        onClick={() => onBillingIntervalChange("annual")}
      >
        Annual
      </button>
      <button
        type="button"
        className={cn(
          "relative shrink-0 whitespace-nowrap rounded-md px-2 py-1.5 text-sm font-medium transition-colors sm:px-3",
          billingInterval === "monthly"
            ? "text-secondary-foreground"
            : "text-muted-foreground",
        )}
        aria-pressed={billingInterval === "monthly"}
        onClick={() => onBillingIntervalChange("monthly")}
      >
        Monthly
      </button>
    </div>
  );
}

/**
 * Compact Team upsell shown beside the current-plan card while on Free, so that
 * panel doesn't sit alone. Mirrors the Team column of the comparison table
 * (price, Popular badge, Upgrade CTA) and reuses the same CTA logic.
 */
function FreePlanTeamUpsell({
  planCatalog,
  currentPlan,
  billingConfigured,
  canManageBilling,
  isBillingActionPending,
  pendingPlanChangeTarget,
  deferredTrialBillingCopy,
  onDowngradePlan,
  onStartPlanChange,
}: {
  planCatalog: PlanCatalog;
  currentPlan: OrganizationPlan;
  billingConfigured: boolean;
  canManageBilling: boolean;
  isBillingActionPending: boolean;
  pendingPlanChangeTarget: "pro" | "team" | null;
  deferredTrialBillingCopy: string | null;
  onDowngradePlan: (
    plan: OrganizationPlan,
    billingInterval: BillingInterval,
  ) => void;
  onStartPlanChange: (
    plan: "pro" | "team",
    billingInterval: BillingInterval,
  ) => void;
}) {
  const [billingInterval, setBillingInterval] =
    useState<BillingInterval>("annual");
  const entry = planCatalog.plans.team;
  if (!entry) {
    return null;
  }

  const priceLabel = formatCatalogPrice(
    entry,
    billingInterval,
    planCatalog.currency,
  );
  const priceSubtext = formatPerSeatCadence("team", entry, billingInterval);
  const cta = getPlanColumnCta({
    plan: "team",
    currentPlan,
    entry,
    billingConfigured,
    canManageBilling,
    isBillingActionPending,
    scheduledCancellationDate: null,
    onDowngradePlan,
    onStartPlanChange,
    billingInterval,
  });
  const showCtaSpinner =
    pendingPlanChangeTarget === "team" && cta.label === "Upgrade";
  const showDeferredTrialBillingCopy =
    deferredTrialBillingCopy != null &&
    cta.label === "Upgrade" &&
    !cta.disabled &&
    !cta.tooltip;

  return (
    <div
      data-testid="free-plan-team-upsell"
      className="flex h-full flex-col gap-5 rounded-xl border border-primary/35 bg-card p-5 md:p-6"
    >
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <span className="text-base font-semibold">{entry.displayName}</span>
          <Badge className="rounded-md bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground">
            Popular
          </Badge>
        </div>
        <div className="w-full space-y-1">
          <div
            role="group"
            aria-label="Billing interval"
            className="mb-2 inline-flex items-center gap-0.5 rounded-md border border-border/60 bg-muted/40 p-0.5 text-xs"
          >
            <button
              type="button"
              className={cn(
                "rounded px-2 py-1 font-medium transition-colors",
                billingInterval === "annual"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground",
              )}
              onClick={() => setBillingInterval("annual")}
            >
              Annual
            </button>
            <button
              type="button"
              className={cn(
                "rounded px-2 py-1 font-medium transition-colors",
                billingInterval === "monthly"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground",
              )}
              onClick={() => setBillingInterval("monthly")}
            >
              Monthly
            </button>
          </div>
          <PlanPriceDisplay label={priceLabel} />
          <p className="text-xs leading-snug text-muted-foreground">
            {priceSubtext}
          </p>
          {entry.seatMinimum ? (
            <p className="text-xs leading-snug text-muted-foreground">
              {entry.seatMinimum} seat minimum
            </p>
          ) : null}
          {showDeferredTrialBillingCopy ? (
            <p className="text-[11px] font-medium leading-tight text-muted-foreground">
              {deferredTrialBillingCopy}
            </p>
          ) : null}
        </div>
      </div>
      {cta.tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              className="w-full shrink-0 rounded-lg"
              size="sm"
              variant={cta.variant}
              aria-disabled={true}
              aria-label={cta.ariaLabel}
              tabIndex={0}
              onClick={undefined}
            >
              <PlanCtaContent showSpinner={showCtaSpinner} label={cta.label} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[14rem] text-center">
            {cta.tooltip}
          </TooltipContent>
        </Tooltip>
      ) : (
        <Button
          className="w-full shrink-0 rounded-lg"
          size="sm"
          variant={cta.variant}
          disabled={cta.disabled}
          onClick={cta.onClick}
        >
          <PlanCtaContent showSpinner={showCtaSpinner} label={cta.label} />
        </Button>
      )}
    </div>
  );
}

interface OrganizationBillingSectionProps {
  organizationId: string;
  showPlanBilling: boolean;
  showPlanComparison?: boolean;
  showCredits: boolean;
  billingStatus: OrganizationBillingStatus | undefined;
  organizationName: string;
  canManageCredits: boolean;
  planCatalog: PlanCatalog | undefined;
  isLoadingBilling: boolean;
  isLoadingPlanCatalog: boolean;
  isStartingPlanChange: boolean;
  pendingPlanChangeTarget: "pro" | "team" | null;
  isOpeningPortal: boolean;
  onDowngradePlan: (
    plan: OrganizationPlan,
    billingInterval: BillingInterval,
  ) => Promise<void>;
  onStartPlanChange: (
    plan: "pro" | "team",
    billingInterval: BillingInterval,
  ) => Promise<void>;
  onStartAutoPlanChange?: (
    plan: "pro" | "team",
    billingInterval: BillingInterval,
  ) => Promise<void>;
  checkoutIntent?: CheckoutIntentWithOrganization | null;
  onCheckoutIntentConsumed?: () => void;
  /** Rendered below the credit usage card (above payments history). */
  currentPlanPanel?: ReactNode;
}

export function OrganizationBillingSection({
  organizationId,
  showPlanBilling,
  showPlanComparison = true,
  showCredits,
  billingStatus,
  organizationName,
  canManageCredits,
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
  currentPlanPanel,
}: OrganizationBillingSectionProps) {
  useCreditTopupReturnFlowBilling({ enabled: showCredits });

  // Plans sit below credits and payment history, so a deep link that lands at
  // the top of the page hides the one thing the user clicked for.
  const [arrivedForPlans, setArrivedForPlans] = useState(false);
  const plansHeadingRef = useRef<HTMLDivElement | null>(null);
  const autoCheckoutStartedForKeyRef = useRef<string | null>(null);
  const [billingInterval, setBillingInterval] =
    useState<BillingInterval>("annual");
  const [checkoutPlanNotice, setCheckoutPlanNotice] = useState<{
    reason: "already_on" | "already_higher";
    currentDisplayName: string;
    requestedDisplayName: string;
  } | null>(null);
  // Set by the plan-card CTAs. Checkout only starts once this is confirmed,
  // so the interval chosen here is the one that reaches Stripe.
  const [pendingPlanChange, setPendingPlanChange] = useState<{
    plan: "pro" | "team";
    interval: BillingInterval;
  } | null>(null);

  // One-shot: consume the flag so a reload doesn't scroll the page again.
  useEffect(() => {
    if (consumeUrlFlag("plans", "open")) setArrivedForPlans(true);
  }, []);

  // Deferred until the section is actually rendering: `showPlanBilling` can
  // arrive a render late while the org's billing permissions resolve.
  useEffect(() => {
    if (!arrivedForPlans || !showPlanBilling) return;
    setArrivedForPlans(false);
    plansHeadingRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, [arrivedForPlans, showPlanBilling]);

  useEffect(() => {
    if (checkoutIntent?.interval) {
      setBillingInterval(checkoutIntent.interval);
    }
  }, [checkoutIntent?.interval]);

  useEffect(() => {
    if (checkoutIntent) return;
    if (billingStatus?.billingInterval === "annual") {
      setBillingInterval("annual");
    } else if (billingStatus?.billingInterval === "monthly") {
      setBillingInterval("monthly");
    }
  }, [billingStatus?.billingInterval, checkoutIntent]);

  useEffect(() => {
    if (!showPlanBilling) {
      return;
    }
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

      if (
        !canCheckoutPlan(
          planCatalog,
          checkoutIntent.plan,
          checkoutIntent.interval,
        )
      ) {
        if (!cancelled) {
          toast.error(
            "This plan or billing interval is not offered to this organization.",
          );
          onCheckoutIntentConsumed?.();
        }
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
            currentDisplayName:
              currentEntry?.displayName ?? intentGuard.currentPlan,
            requestedDisplayName:
              requestedEntry?.displayName ?? checkoutIntent.plan,
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
    showPlanBilling,
  ]);

  const currentPlan = billingStatus?.plan ?? "free";
  const billingConfigured = billingStatus?.billingConfigured ?? false;
  const canManageBilling = billingStatus?.canManageBilling ?? false;
  const isBillingActionPending = isStartingPlanChange || isOpeningPortal;
  const compareSections = planCatalog
    ? buildComparePlanSectionsFromCatalog(planCatalog)
    : null;
  const deferredTrialBillingCopy = getDeferredTrialBillingCopy(billingStatus);
  const isTrial = billingStatus?.source === "trial";
  const showFreeTeamUpsell =
    showPlanBilling &&
    !isLoadingBilling &&
    !isTrial &&
    currentPlan === "free" &&
    planCatalog != null &&
    planCatalog.plans.team != null &&
    !planCatalog.plans.pro;

  const pendingPlanEntry = pendingPlanChange
    ? planCatalog?.plans[pendingPlanChange.plan]
    : undefined;

  const requestPlanChange = (
    plan: "pro" | "team",
    targetBillingInterval: BillingInterval,
  ) => {
    setPendingPlanChange({ plan, interval: targetBillingInterval });
    track("plans_upgrade_confirm_shown", {
      location: "org_plans",
      organization_id: organizationId,
      target_plan: plan,
      billing_interval: targetBillingInterval,
      current_plan: currentPlan,
    });
  };

  const handleConfirmPlanChange = async () => {
    if (!pendingPlanChange) return;
    const { plan, interval } = pendingPlanChange;
    track("plans_upgrade_confirm_submitted", {
      location: "org_plans",
      organization_id: organizationId,
      target_plan: plan,
      billing_interval: interval,
      price_cents: planCatalog?.plans[plan]?.prices[interval] ?? null,
      current_plan: currentPlan,
    });
    try {
      await onStartPlanChange(plan, interval);
    } finally {
      // The checkout redirect leaves this page, but a failure or an in-place
      // plan update does not: either way the confirmation is spent.
      setPendingPlanChange(null);
    }
  };

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

      {pendingPlanChange && pendingPlanEntry && planCatalog ? (
        <PlanChangeConfirmDialog
          open
          onOpenChange={(open) => {
            if (open || isStartingPlanChange) return;
            track("plans_upgrade_confirm_dismissed", {
              location: "org_plans",
              organization_id: organizationId,
              target_plan: pendingPlanChange.plan,
              billing_interval: pendingPlanChange.interval,
              current_plan: currentPlan,
            });
            setPendingPlanChange(null);
          }}
          plan={pendingPlanChange.plan}
          entry={pendingPlanEntry}
          currency={planCatalog.currency}
          interval={pendingPlanChange.interval}
          onIntervalChange={(nextInterval) => {
            setPendingPlanChange({
              plan: pendingPlanChange.plan,
              interval: nextInterval,
            });
            // Keep the comparison table showing the interval that is about to
            // be bought, so the page still matches after the dialog closes.
            setBillingInterval(nextInterval);
            track("plans_upgrade_confirm_interval_selected", {
              location: "org_plans",
              organization_id: organizationId,
              target_plan: pendingPlanChange.plan,
              billing_interval: nextInterval,
              price_cents: pendingPlanEntry.prices[nextInterval] ?? null,
              current_plan: currentPlan,
            });
          }}
          annualDiscountPct={getAnnualDiscountPercent(
            planCatalog,
            pendingPlanChange.plan,
          )}
          currentPlanName={
            planCatalog.plans[currentPlan]?.displayName ?? currentPlan
          }
          seatQuantity={billingStatus?.stripeSeatQuantity ?? null}
          isNewSubscription={currentPlan === "free"}
          isStarting={isStartingPlanChange}
          onConfirm={() => void handleConfirmPlanChange()}
        />
      ) : null}

      {showCredits ? (
        <ErrorBoundary
          name="org_billing_credit_balance"
          fallback={({ error, reset }) => (
            <ErrorCard error={error} onRetry={reset} />
          )}
        >
          <CreditBalanceCard
            organizationName={organizationName}
            pricingVersion={billingStatus?.pricingVersion}
            organizationId={organizationId}
            canManageCredits={canManageCredits}
          />
        </ErrorBoundary>
      ) : null}

      {showFreeTeamUpsell && planCatalog ? (
        <div className="grid items-stretch gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          {currentPlanPanel}
          <FreePlanTeamUpsell
            planCatalog={planCatalog}
            currentPlan={currentPlan}
            billingConfigured={billingConfigured}
            canManageBilling={canManageBilling}
            isBillingActionPending={isBillingActionPending}
            pendingPlanChangeTarget={pendingPlanChangeTarget}
            deferredTrialBillingCopy={deferredTrialBillingCopy}
            onDowngradePlan={(plan, interval) =>
              void onDowngradePlan(plan, interval)
            }
            onStartPlanChange={requestPlanChange}
          />
        </div>
      ) : (
        currentPlanPanel
      )}

      {showCredits ? (
        <ErrorBoundary
          name="org_billing_payments_history"
          fallback={({ error, reset }) => (
            <ErrorCard error={error} onRetry={reset} />
          )}
        >
          <PaymentsHistorySection
            organizationId={organizationId}
            canViewHistory={showCredits && canManageCredits}
            canViewInvoices={
              !!(showPlanBilling && billingStatus?.canManageBilling)
            }
          />
        </ErrorBoundary>
      ) : null}

      {showPlanBilling && showPlanComparison ? (
        <>
          {checkoutIntent ? (
            <div
              className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
              data-testid="billing-deep-link-redirect"
            >
              <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
              Redirecting to checkout…
            </div>
          ) : null}
          <div className="space-y-1.5" ref={plansHeadingRef}>
            <div className="flex items-center gap-2 text-xl font-semibold tracking-tight">
              <CreditCard
                className="size-5 shrink-0 text-muted-foreground"
                aria-hidden
              />
              Plan options
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
                  Purchases are unavailable here. You can still view the plans.
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

          <Card className="border-border/60 py-6 shadow-sm">
            <CardContent className="px-0 pb-0 pt-0">
              {isLoadingPlanCatalog || !planCatalog ? (
                <div className="px-4 py-6 sm:px-6">
                  <div className="mb-4 space-y-1">
                    <p className="text-xs font-semibold uppercase tracking-wider text-primary">
                      Compare plans
                    </p>
                    <CardTitle className="text-sm font-semibold leading-snug sm:text-base">
                      {planCatalog?.plans.pro
                        ? "Compare plans"
                        : "Compare Free vs Team"}
                    </CardTitle>
                    <p className="pt-1 text-xs leading-snug text-muted-foreground">
                      {ORG_COMPARE_PLANS_NOTE}
                    </p>
                  </div>
                  <div className="mb-4">
                    <BillingIntervalToggle
                      billingInterval={billingInterval}
                      onBillingIntervalChange={setBillingInterval}
                    />
                  </div>
                  <div className="rounded-md border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
                    Loading plan catalog...
                  </div>
                </div>
              ) : (
                <div className="relative w-full overflow-x-auto overscroll-x-contain">
                  <div className="min-w-[44rem] px-4 pb-6 sm:px-6">
                    <Table className="table-fixed">
                      <TableHeader>
                        <TableRow className="border-b hover:bg-transparent [&_th]:align-top [&_th]:h-full">
                          <TableHead
                            style={{ width: `${LABEL_COLUMN_WIDTH_PCT}%` }}
                            className="sticky left-0 z-20 h-full min-h-0 whitespace-normal bg-card text-left shadow-[1px_0_0_0_hsl(var(--border))] px-4 pt-5 pb-4 align-top"
                          >
                            <div className="flex h-full min-h-[11rem] flex-col">
                              <div className="flex min-h-0 flex-1 flex-col">
                                <div className="space-y-1 pr-1">
                                  <p className="text-xs font-semibold uppercase tracking-wider text-primary">
                                    Compare plans
                                  </p>
                                  <CardTitle className="text-sm font-semibold leading-snug sm:text-base">
                                    {planCatalog?.plans.pro
                                      ? "Compare plans"
                                      : "Compare Free vs Team"}
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
                                />
                              </div>
                            </div>
                          </TableHead>
                          {offeredPlans(planCatalog).map((plan) => {
                            const entry = planCatalog.plans[plan]!;
                            const isEnterprisePlan = plan === "enterprise";
                            const priceLabel = isEnterprisePlan
                              ? "Custom"
                              : plan === "free"
                              ? "$0"
                              : formatCatalogPrice(
                                  entry,
                                  billingInterval,
                                  planCatalog.currency,
                                );
                            const priceSubtext = isEnterprisePlan
                              ? formatPerSeatCadence(
                                  plan,
                                  entry,
                                  billingInterval,
                                )
                              : plan === "free"
                              ? "No credit card required"
                              : formatPerSeatCadence(
                                  plan,
                                  entry,
                                  billingInterval,
                                );
                            const cancellationDateMs =
                              billingStatus?.stripeCancelAt ??
                              billingStatus?.stripeCurrentPeriodEnd ??
                              null;
                            const scheduledCancellationDate =
                              billingStatus?.stripeCancelAtPeriodEnd
                                ? cancellationDateMs != null
                                  ? formatBillingDate(cancellationDateMs)
                                  : ""
                                : null;
                            const cta = getPlanColumnCta({
                              plan,
                              currentPlan,
                              currentCatalogPlanId:
                                billingStatus?.catalogPlanId,
                              entry,
                              billingConfigured,
                              canManageBilling,
                              isBillingActionPending,
                              scheduledCancellationDate,
                              onDowngradePlan: (
                                targetPlan,
                                targetBillingInterval,
                              ) =>
                                void onDowngradePlan(
                                  targetPlan,
                                  targetBillingInterval,
                                ),
                              onStartPlanChange: requestPlanChange,
                              billingInterval,
                            });
                            const showPlanChangeSpinner =
                              pendingPlanChangeTarget === plan &&
                              (cta.label === "Upgrade" ||
                                cta.label === "Downgrade" ||
                                cta.label === "Change plan") &&
                              (plan === "team" || plan === "pro");
                            const showCtaSpinner = showPlanChangeSpinner;
                            const isPopular = plan === POPULAR_PLAN;
                            const showDeferredTrialBillingCopy =
                              deferredTrialBillingCopy != null &&
                              cta.label === "Upgrade" &&
                              !cta.disabled &&
                              !cta.tooltip &&
                              plan === "team";
                            return (
                              <TableHead
                                key={plan}
                                style={{
                                  width: `${
                                    PLAN_COLUMNS_WIDTH_PCT /
                                    offeredPlans(planCatalog).length
                                  }%`,
                                }}
                                className={cn(
                                  "h-full min-h-0 whitespace-normal px-3 pt-5 pb-4 text-center align-top",
                                  isPopular && POPULAR_COLUMN_CLASS,
                                )}
                              >
                                <div
                                  className={cn(
                                    "mx-auto flex h-full min-h-[11rem] w-full max-w-[13rem] flex-col",
                                    isV2PlanCatalog(planCatalog) &&
                                      "h-[11rem] gap-3",
                                  )}
                                >
                                  <div className="flex min-h-0 flex-1 flex-col items-center gap-3">
                                    <div
                                      className={cn(
                                        "flex flex-wrap items-center justify-center gap-2",
                                        isV2PlanCatalog(planCatalog) &&
                                          "min-h-10",
                                      )}
                                    >
                                      <span className="text-base font-semibold">
                                        {entry.displayName}
                                      </span>
                                      {isLegacyTeamEntry(entry) ? (
                                        <Badge variant="outline">Legacy</Badge>
                                      ) : null}
                                      {isPopular ? (
                                        <Badge className="rounded-md bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground">
                                          Popular
                                        </Badge>
                                      ) : null}
                                    </div>
                                    <div className="w-full space-y-1 text-center">
                                      <PlanPriceDisplay label={priceLabel} />
                                      <p className="text-xs leading-snug text-muted-foreground">
                                        {isV2PlanCatalog(planCatalog) &&
                                        entry.billingModel === "flat"
                                          ? billingInterval === "annual"
                                            ? "Billed annually"
                                            : "Billed monthly"
                                          : priceSubtext}
                                      </p>
                                      {entry.seatMinimum ? (
                                        <p className="text-xs leading-snug text-muted-foreground">
                                          {entry.seatMinimum} seat minimum
                                        </p>
                                      ) : null}
                                      {showDeferredTrialBillingCopy ? (
                                        <p className="text-[11px] font-medium leading-tight text-muted-foreground">
                                          {deferredTrialBillingCopy}
                                        </p>
                                      ) : null}
                                    </div>
                                  </div>
                                  {cta.tooltip ? (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Button
                                          className="w-full shrink-0 rounded-lg"
                                          size="sm"
                                          variant={cta.variant}
                                          aria-disabled={true}
                                          aria-label={cta.ariaLabel}
                                          tabIndex={0}
                                          onClick={undefined}
                                        >
                                          <PlanCtaContent
                                            showSpinner={showCtaSpinner}
                                            label={cta.label}
                                          />
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent
                                        side="top"
                                        className="max-w-[14rem] text-center"
                                      >
                                        {cta.tooltip}
                                      </TooltipContent>
                                    </Tooltip>
                                  ) : (
                                    <Button
                                      className="w-full shrink-0 rounded-lg"
                                      size="sm"
                                      variant={cta.variant}
                                      disabled={cta.disabled}
                                      onClick={cta.onClick}
                                    >
                                      <PlanCtaContent
                                        showSpinner={showCtaSpinner}
                                        label={cta.label}
                                      />
                                    </Button>
                                  )}
                                </div>
                              </TableHead>
                            );
                          })}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(compareSections ?? []).map((section) => (
                          <Fragment key={section.title}>
                            {!section.hideTitle ? (
                              <TableRow className="border-b hover:bg-transparent">
                                <FullWidthRowCells
                                  plans={offeredPlans(planCatalog)}
                                  className="bg-muted/40 py-2.5 pl-4"
                                >
                                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                    {section.title}
                                  </div>
                                </FullWidthRowCells>
                              </TableRow>
                            ) : null}
                            {section.rows.map((row, rowIndex) => {
                              if (isV2PlanCatalog(planCatalog)) {
                                return (
                                  <V2ComparisonRow
                                    key={row.label}
                                    row={row}
                                    plans={offeredPlans(planCatalog)}
                                  />
                                );
                              }
                              return (
                                <TableRow
                                  key={`${section.title}-${rowIndex}-${row.label}`}
                                  className="border-b"
                                >
                                  <TableCell className="sticky left-0 z-10 max-w-[14rem] whitespace-normal bg-card py-3 pl-4 text-sm font-medium shadow-[1px_0_0_0_hsl(var(--border))] sm:max-w-none">
                                    <ComparePlanRowLabel
                                      label={row.label}
                                      tooltipKey={row.tooltipKey}
                                    />
                                  </TableCell>
                                  {offeredPlans(planCatalog).map((plan) => {
                                    const isPopular = plan === POPULAR_PLAN;
                                    return (
                                      <TableCell
                                        key={plan}
                                        className={cn(
                                          "max-w-[13rem] whitespace-normal px-3 py-3 text-center align-middle text-sm",
                                          isPopular && POPULAR_COLUMN_CLASS,
                                        )}
                                      >
                                        <ComparePlanMatrixCell
                                          cell={
                                            row[plan] ?? {
                                              kind: "text",
                                              text: "—",
                                            }
                                          }
                                        />
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
        </>
      ) : null}
    </div>
  );
}
