import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import type { BillingInterval } from "@/hooks/useOrganizationBilling";
import { cn } from "@/lib/utils";

interface UpgradeIntervalPickerProps {
  interval: BillingInterval;
  onIntervalChange: (interval: BillingInterval) => void;
  /** Bare per-seat monthly amounts, e.g. "$30". The unit is rendered here so
   * the large number never wraps mid-phrase. Null while the catalog loads. */
  annualPriceLabel: string | null;
  monthlyPriceLabel: string | null;
  annualDiscountPct: number;
  annualSupported: boolean;
  monthlySupported: boolean;
  teamName: string;
  isStarting: boolean;
  /** Catalog still in flight: the cards have no prices yet, so checkout must
   * not be reachable. */
  isLoadingPrices?: boolean;
  onUpgrade: () => void;
  className?: string;
}

interface IntervalOption {
  interval: BillingInterval;
  label: string;
  cadence: string;
  priceLabel: string | null;
}

/**
 * Both billing intervals side by side, so neither price is hidden behind a
 * toggle, then an explicit confirm. Same select-then-confirm shape as the
 * credit preset dialog.
 */
export function UpgradeIntervalPicker({
  interval,
  onIntervalChange,
  annualPriceLabel,
  monthlyPriceLabel,
  annualDiscountPct,
  annualSupported,
  monthlySupported,
  teamName,
  isStarting,
  isLoadingPrices = false,
  onUpgrade,
  className,
}: UpgradeIntervalPickerProps) {
  const options: IntervalOption[] = [
    ...(annualSupported
      ? [
          {
            interval: "annual" as const,
            label: "Annual",
            cadence: "Billed annually",
            priceLabel: annualPriceLabel,
          },
        ]
      : []),
    ...(monthlySupported
      ? [
          {
            interval: "monthly" as const,
            label: "Monthly",
            cadence: "Billed monthly",
            priceLabel: monthlyPriceLabel,
          },
        ]
      : []),
  ];

  if (options.length === 0) return null;

  // A card with no price has nothing to confirm, so the CTA waits with it.
  // In practice that only happens while the catalog is still in flight, which
  // is what the button says.
  const hasSelectedPrice = options.some(
    (option) => option.interval === interval && option.priceLabel,
  );
  const isWaitingForPrice = isLoadingPrices || !hasSelectedPrice;

  return (
    <div className={cn("space-y-3", className)}>
      <div
        className={cn(
          "grid gap-2",
          options.length > 1 ? "sm:grid-cols-2" : "grid-cols-1",
        )}
        role="radiogroup"
        aria-label="Billing interval"
      >
        {options.map((option) => {
          const isSelected = option.interval === interval;
          return (
            <button
              key={option.interval}
              type="button"
              role="radio"
              aria-checked={isSelected}
              disabled={isStarting || isLoadingPrices}
              onClick={() => onIntervalChange(option.interval)}
              data-testid={`upgrade-interval-${option.interval}`}
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
                <span className="text-sm font-medium">{option.label}</span>
                {option.interval === "annual" && annualDiscountPct > 0 ? (
                  <Badge className="rounded-md bg-primary px-1.5 py-0 text-[10px] font-semibold text-primary-foreground">
                    Save {annualDiscountPct}%
                  </Badge>
                ) : null}
              </span>
              {option.priceLabel ? (
                <>
                  <span className="text-xl font-semibold leading-tight tracking-tight">
                    {option.priceLabel}
                  </span>
                  <span className="text-xs leading-snug text-muted-foreground">
                    per seat/month
                  </span>
                </>
              ) : null}
              <span className="text-xs leading-snug text-muted-foreground">
                {option.cadence}
              </span>
            </button>
          );
        })}
      </div>
      <Button
        type="button"
        className="w-full"
        onClick={onUpgrade}
        disabled={isStarting || isWaitingForPrice}
        data-testid="upgrade-plan-cta"
      >
        {isWaitingForPrice
          ? "Loading prices…"
          : isStarting
          ? "Redirecting…"
          : `Upgrade to ${teamName}`}
      </Button>
    </div>
  );
}
