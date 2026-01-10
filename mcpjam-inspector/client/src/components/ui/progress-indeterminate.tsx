import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * An indeterminate progress bar for when the total is unknown.
 * Shows an animated sliding bar.
 */
function ProgressIndeterminate({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="progress-indeterminate"
      className={cn(
        "bg-primary/20 relative h-2 w-full overflow-hidden rounded-full",
        className,
      )}
      {...props}
    >
      <div
        data-slot="progress-indeterminate-indicator"
        className="bg-primary h-full w-1/3 absolute rounded-full animate-[progress-indeterminate_1.5s_ease-in-out_infinite]"
      />
    </div>
  );
}

export { ProgressIndeterminate };
