import { Badge } from "@mcpjam/design-system/badge";
import type { BillingInterval } from "@/hooks/useOrganizationBilling";
import { cn } from "@/lib/utils";

interface UpgradeIntervalPickerProps {
  /** Per-seat monthly figures, already formatted. Null while the catalog loads. */
  annualPriceLabel: string | null;
  monthlyPriceLabel: string | null;
  annualDiscountPct: number;
  annualSupported: boolean;
  monthlySupported: boolean;
  teamName: string;
  isStarting: boolean;
  onUpgrade: (interval: BillingInterval) => void;
  className?: string;
}

interface IntervalOption {
  interval: BillingInterval;
  label: string;
  cadence: string;
  priceLabel: string | null;
}

/**
 * Both billing intervals as side-by-side buttons, so choosing one and starting
 * checkout is a single press. A toggle would hide one of the two prices behind
 * a click the user has to think to make, which is the wrong trade at a wall.
 *
 * Pressing a card leads to Stripe, where the user still confirms before paying,
 * so there is no destructive outcome from a single click here.
 */
export function UpgradeIntervalPicker({
  annualPriceLabel,
  monthlyPriceLabel,
  annualDiscountPct,
  annualSupported,
  monthlySupported,
  teamName,
  isStarting,
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

  return (
    <div className={cn("space-y-2", className)}>
      <div
        className={cn(
          "grid gap-2",
          options.length > 1 ? "sm:grid-cols-2" : "grid-cols-1",
        )}
      >
        {options.map((option) => (
          <button
            key={option.interval}
            type="button"
            disabled={isStarting}
            onClick={() => onUpgrade(option.interval)}
            data-testid={`upgrade-${option.interval}`}
            aria-label={`Upgrade to ${teamName}, ${option.label.toLowerCase()} billing`}
            className={cn(
              "flex flex-col gap-1 rounded-lg border border-border p-3 text-left transition-colors",
              "hover:border-foreground/40 hover:bg-muted/40",
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
              <span className="text-xl font-semibold leading-tight tracking-tight">
                {option.priceLabel}
              </span>
            ) : null}
            <span className="text-xs leading-snug text-muted-foreground">
              {option.cadence}
            </span>
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {isStarting
          ? "Redirecting to checkout…"
          : "You'll confirm on Stripe before paying."}
      </p>
    </div>
  );
}
