import type { ReactNode } from "react";
import { Clock } from "lucide-react";

/** A waiting state, such as "Requested", in an info-tinted pill. */
export function ClockPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-info/18 px-2 text-xs font-medium leading-5 text-foreground">
      <Clock className="size-3" aria-hidden="true" />
      {children}
    </span>
  );
}
