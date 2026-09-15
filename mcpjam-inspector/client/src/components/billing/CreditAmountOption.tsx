import { CoinStackIcon } from "@/components/ui/coin-stack-icon";
import { cn } from "@/lib/utils";

export function CreditAmountOption({
  credits,
  price,
  selected,
  disabled,
  onSelect,
}: {
  credits: string;
  price: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-label={`${credits} credits ${price}`}
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex flex-col items-center justify-center rounded-md border px-3 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        selected
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border hover:border-foreground/40",
      )}
    >
      <span className="flex items-center gap-1 text-lg font-semibold leading-tight">
        <CoinStackIcon aria-hidden="true" className="size-4" />
        {credits}
      </span>
      <span className="text-xs text-muted-foreground">credits</span>
      <span className="mt-1 text-xs text-foreground">{price}</span>
    </button>
  );
}
