import { useId } from "react";
import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@/lib/utils";
import type { BillingInterval } from "@/hooks/useOrganizationBilling";

const INTERVALS = ["monthly", "annual"] as const;

function otherInterval(interval: BillingInterval): BillingInterval {
  return interval === "monthly" ? "annual" : "monthly";
}

export function BillingIntervalToggle({
  billingInterval,
  onChange,
  annualDiscount = 0,
  className,
  discountPrefix = "Save",
  size = "default",
}: {
  billingInterval: BillingInterval;
  onChange: (interval: BillingInterval) => void;
  annualDiscount?: number;
  className?: string;
  discountPrefix?: string;
  size?: "default" | "sm";
}) {
  const groupName = useId();
  const compact = size === "sm";
  return (
    <fieldset
      className={cn(
        "relative inline-grid grid-cols-2 rounded-xl border border-border bg-secondary/50",
        compact ? "p-0.5" : "p-1",
        className,
      )}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onChange(otherInterval(billingInterval));
        }
      }}
    >
      <legend className="sr-only">Billing interval</legend>
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute rounded-xl bg-foreground transition-transform duration-200 ease-out motion-reduce:transition-none",
          compact
            ? "top-0.5 bottom-0.5 left-0.5 w-[calc(50%-0.125rem)]"
            : "top-1 bottom-1 left-1 w-[calc(50%-0.25rem)]",
          billingInterval === "annual" && "translate-x-full",
        )}
      />
      {INTERVALS.map((interval) => {
        const selected = billingInterval === interval;
        return (
          <label key={interval} className="relative z-10 cursor-pointer">
            <input
              type="radio"
              name={groupName}
              value={interval}
              checked={selected}
              onChange={() => onChange(interval)}
              onClick={() => {
                if (selected) onChange(otherInterval(interval));
              }}
              className="peer sr-only"
            />
            <span
              className={cn(
                "flex h-full w-full items-center justify-center rounded-xl font-medium transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring",
                selected
                  ? "text-background"
                  : "text-muted-foreground hover:text-foreground",
                compact
                  ? "min-h-8 gap-1 px-2.5 text-xs"
                  : "min-h-10 gap-1.5 px-3 text-xs sm:gap-2 sm:px-4 sm:text-sm",
              )}
            >
              {interval === "monthly" ? "Monthly" : "Annual"}
              {interval === "annual" && annualDiscount > 0 ? (
                <Badge className="rounded-lg px-1 py-px text-[10px] leading-tight">
                  {discountPrefix
                    ? `${discountPrefix} ${annualDiscount}%${
                        discountPrefix === "Up to" ? " off" : ""
                      }`
                    : `${annualDiscount}% off`}
                </Badge>
              ) : null}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
