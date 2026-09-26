import { ArrowRight } from "lucide-react";

import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import type {
  BillingInterval,
  PlanCatalogEntry,
} from "@/hooks/useOrganizationBilling";
import {
  canCheckoutPlanEntry,
  formatCatalogPrice,
} from "@/lib/pricing-catalog";
import { cn } from "@/lib/utils";

interface PlanChangeConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plan: "pro" | "team";
  entry: PlanCatalogEntry;
  currency: string;
  interval: BillingInterval;
  onIntervalChange: (interval: BillingInterval) => void;
  annualDiscountPct: number | null;
  currentPlanName: string;
  /** Seats Stripe will bill on a per-seat plan. Null when the organization has
   * no subscription yet, in which case no total is claimed here. */
  seatQuantity: number | null;
  /** No paid subscription yet, so confirming opens Stripe checkout rather than
   * changing an existing subscription. */
  isNewSubscription: boolean;
  isStarting: boolean;
  onConfirm: () => void;
}

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/**
 * What the charge actually is, as opposed to the per-month rate the plan cards
 * advertise: an annual price is a full year billed at once.
 */
function formatChargeLine(
  entry: PlanCatalogEntry,
  interval: BillingInterval,
  currency: string,
  seatQuantity: number | null,
): string | null {
  const price = entry.prices[interval];
  if (price == null) return null;
  const cadence = interval === "annual" ? "year" : "month";
  if (entry.billingModel === "per_seat") {
    // Without a seat count from Stripe the total would be a guess, and a
    // billing confirmation is the last place to guess. Checkout states it.
    if (seatQuantity == null) return null;
    const seatLabel = seatQuantity === 1 ? "seat" : "seats";
    return `${formatMoney(
      price * seatQuantity,
      currency,
    )} per ${cadence} (${seatQuantity} ${seatLabel})`;
  }
  return `${formatMoney(price, currency)} per ${cadence}`;
}

/**
 * Confirmation step between the plan cards and Stripe. It restates the plan,
 * keeps the interval changeable where the decision is actually being made, and
 * names the amount and renewal terms before the browser leaves the app.
 */
export function PlanChangeConfirmDialog({
  open,
  onOpenChange,
  plan,
  entry,
  currency,
  interval,
  onIntervalChange,
  annualDiscountPct,
  currentPlanName,
  seatQuantity,
  isNewSubscription,
  isStarting,
  onConfirm,
}: PlanChangeConfirmDialogProps) {
  const options = (["annual", "monthly"] as const).filter((candidate) =>
    canCheckoutPlanEntry(entry, plan, candidate),
  );
  const chargeLine = formatChargeLine(entry, interval, currency, seatQuantity);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Confirm your plan</DialogTitle>
          <DialogDescription>
            Review the plan and billing cycle. Payment is completed on Stripe.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{currentPlanName}</span>
            <ArrowRight className="size-4 text-muted-foreground" aria-hidden />
            <span className="font-medium text-foreground">
              {entry.displayName}
            </span>
          </div>

          <div
            role="radiogroup"
            aria-label="Billing interval"
            className={cn(
              "grid gap-2",
              options.length > 1 ? "sm:grid-cols-2" : "grid-cols-1",
            )}
          >
            {options.map((option) => {
              const isSelected = option === interval;
              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  disabled={isStarting}
                  onClick={() => onIntervalChange(option)}
                  data-testid={`plan-confirm-interval-${option}`}
                  className={cn(
                    "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
                    isSelected
                      ? "border-primary bg-primary/10"
                      : "border-border hover:border-foreground/40",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    "disabled:pointer-events-none disabled:opacity-60",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {option === "annual" ? "Annual" : "Monthly"}
                    </span>
                    {option === "annual" &&
                    annualDiscountPct != null &&
                    annualDiscountPct > 0 ? (
                      <Badge className="rounded-md bg-primary px-1.5 py-0 text-[10px] font-semibold text-primary-foreground">
                        Save {annualDiscountPct}%
                      </Badge>
                    ) : null}
                  </span>
                  <span className="text-lg font-semibold leading-tight tracking-tight tabular-nums">
                    {formatCatalogPrice(entry, option, currency)}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="space-y-1 rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">
                {isNewSubscription ? "Due at checkout" : "New charge"}
              </span>
              <span
                className="text-right font-medium tabular-nums text-foreground"
                data-testid="plan-confirm-charge"
              >
                {chargeLine ?? "Confirmed at checkout"}
              </span>
            </div>
            {entry.seatMinimum ? (
              <p className="text-xs text-muted-foreground">
                {entry.seatMinimum} seat minimum
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {interval === "annual"
                ? "Renews every year until canceled."
                : "Renews every month until canceled."}{" "}
              Taxes are calculated at checkout.
            </p>
            {!isNewSubscription ? (
              <p className="text-xs text-muted-foreground">
                Stripe prorates the change against your current subscription.
              </p>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isStarting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            disabled={isStarting || entry.prices[interval] == null}
            data-testid="plan-confirm-cta"
          >
            {isStarting
              ? "Redirecting…"
              : isNewSubscription
              ? "Continue to checkout"
              : `Confirm ${entry.displayName}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
