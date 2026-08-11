import { Button } from "@mcpjam/design-system/button";
import type { BillingInterval } from "@/hooks/useOrganizationBilling";
import { cn } from "@/lib/utils";

interface UpgradeIntervalPickerProps {
  interval: BillingInterval;
  onIntervalChange: (interval: BillingInterval) => void;
  /** Per-seat monthly figure, already formatted. Null while the catalog loads. */
  priceLabel: string | null;
  annualDiscountPct: number;
  annualSupported: boolean;
  monthlySupported: boolean;
  teamName: string;
  isStarting: boolean;
  onUpgrade: () => void;
  className?: string;
}

/**
 * Interval choice plus the upgrade CTA, shared by the eval and credits walls.
 * Both intervals are shown up front so the user isn't deciding blind, and the
 * toggle markup mirrors the billing page's compare card for consistency.
 */
export function UpgradeIntervalPicker({
  interval,
  onIntervalChange,
  priceLabel,
  annualDiscountPct,
  annualSupported,
  monthlySupported,
  teamName,
  isStarting,
  onUpgrade,
  className,
}: UpgradeIntervalPickerProps) {
  const showToggle = annualSupported && monthlySupported;
  const cadence =
    interval === "annual" ? "Billed annually" : "Billed monthly";

  return (
    <div className={cn("space-y-2", className)}>
      {showToggle ? (
        <div
          role="group"
          aria-label="Billing interval"
          className="inline-flex items-center gap-0.5 rounded-md border border-border/60 bg-muted/40 p-0.5 text-xs"
        >
          <button
            type="button"
            aria-pressed={interval === "annual"}
            className={cn(
              "flex items-center gap-1.5 rounded px-2 py-1 font-medium transition-colors",
              interval === "annual"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground",
            )}
            onClick={() => onIntervalChange("annual")}
          >
            Annual
            {annualDiscountPct > 0 ? (
              <span className="text-[10px] font-semibold text-primary">
                Save {annualDiscountPct}%
              </span>
            ) : null}
          </button>
          <button
            type="button"
            aria-pressed={interval === "monthly"}
            className={cn(
              "rounded px-2 py-1 font-medium transition-colors",
              interval === "monthly"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground",
            )}
            onClick={() => onIntervalChange("monthly")}
          >
            Monthly
          </button>
        </div>
      ) : null}

      {priceLabel ? (
        <div>
          <p className="text-lg font-semibold leading-tight tracking-tight">
            {priceLabel}
          </p>
          <p className="text-xs leading-snug text-muted-foreground">
            {cadence}
          </p>
        </div>
      ) : null}

      <Button
        type="button"
        className="w-full"
        onClick={onUpgrade}
        disabled={isStarting}
        data-testid="upgrade-plan-cta"
      >
        {isStarting ? "Redirecting…" : `Upgrade to ${teamName}`}
      </Button>
    </div>
  );
}
