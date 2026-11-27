import * as React from "react";
import { Progress as ProgressPrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../cn";

const progressIndicatorVariants = cva(
  "h-full w-full flex-1 transition-all motion-reduce:transition-none",
  {
    variants: {
      tone: {
        primary: "bg-primary",
        // For progress toward something the user finishes, such as setup.
        success: "bg-success",
      },
      pace: {
        default: "",
        gradual: "duration-700 ease-out",
        // For a bar that animates in from empty, such as a refilled balance.
        fill: "duration-1000 ease-[cubic-bezier(0.22,1,0.36,1)]",
      },
    },
    defaultVariants: {
      tone: "primary",
      pace: "default",
    },
  },
);

function Progress({
  className,
  value,
  tone,
  pace,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> &
  VariantProps<typeof progressIndicatorVariants>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "bg-primary/20 relative h-2 w-full overflow-hidden rounded-full",
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={progressIndicatorVariants({ tone, pace })}
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress, progressIndicatorVariants };
