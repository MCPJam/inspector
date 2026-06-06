import { Info } from "lucide-react";
import { cn } from "@/lib/chat-utils";

/**
 * Inline note shown on team (per-seat) plans wherever a seat can change: the
 * org Members add/remove flow and the project Share invite row. Explains that
 * mid-cycle seat changes are prorated both ways (charge + credits when adding,
 * refund + clawback when removing) so users aren't surprised by partial amounts.
 */
export function SeatProrationNote({ className }: { className?: string }) {
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
      <span>
        <span className="font-medium text-foreground">
          Seat changes are prorated to your billing cycle.
        </span>{" "}
        Adding a seat charges and credits you for the days left. Removing one
        refunds the unused days and reclaims its leftover credits. Credits
        already spent aren't refunded.
      </span>
    </p>
  );
}
