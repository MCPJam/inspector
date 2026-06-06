import { Info } from "lucide-react";
import { cn } from "@/lib/chat-utils";

/**
 * Inline note shown on team (per-seat) plans wherever an action adds a billed
 * seat — the org Members "Add member" row and the project Share invite row.
 * Explains that mid-cycle seat changes are prorated (charge + credits), so
 * users aren't surprised by the partial amounts.
 */
export function SeatProrationNote({
  lead = "This adds a seat.",
  className,
}: {
  /** Bold lead sentence; differs slightly per surface. */
  lead?: string;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
      <span>
        <span className="font-medium text-foreground">{lead}</span> You're
        charged for the days left in this billing period, and get partial credits
        to match.
      </span>
    </p>
  );
}
