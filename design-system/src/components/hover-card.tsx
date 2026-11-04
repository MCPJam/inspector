import * as React from "react";
import { HoverCard as HoverCardPrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../cn";
import { tooltipArrowClassName, tooltipPillClassName } from "./tooltip";

function HoverCard({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />;
}

function HoverCardTrigger({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return (
    <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
  );
}

const hoverCardContentVariants = cva(
  "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 origin-(--radix-hover-card-content-transform-origin) outline-hidden",
  {
    variants: {
      variant: {
        card: "bg-popover text-popover-foreground w-64 rounded-md border p-4 shadow-md",
        // No surface of its own: HoverCardHeader paints the tooltip pill and
        // HoverCardBody the popover under it, so a header-only card looks
        // exactly like TooltipContent and a fuller one is that pill with a
        // body attached.
        tooltip: "flex w-fit max-w-xs flex-col text-xs",
      },
    },
    defaultVariants: { variant: "card" },
  },
);

function HoverCardContent({
  className,
  align = "center",
  sideOffset = 4,
  variant,
  children,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content> &
  VariantProps<typeof hoverCardContentVariants>) {
  return (
    <HoverCardPrimitive.Portal data-slot="hover-card-portal">
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        data-variant={variant ?? "card"}
        align={align}
        sideOffset={sideOffset}
        className={cn(hoverCardContentVariants({ variant }), className)}
        {...props}
      >
        {children}
        {variant === "tooltip" ? (
          <HoverCardPrimitive.Arrow className={tooltipArrowClassName} />
        ) : null}
      </HoverCardPrimitive.Content>
    </HoverCardPrimitive.Portal>
  );
}

/** The tooltip pill. Rounds only its top corners when a body follows. */
function HoverCardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="hover-card-header"
      className={cn(
        tooltipPillClassName,
        "[&:has(+[data-slot=hover-card-body])]:rounded-b-none",
        className,
      )}
      {...props}
    />
  );
}

function HoverCardBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="hover-card-body"
      className={cn(
        "flex flex-col gap-2 rounded-b-md border border-t-0 bg-popover p-3 text-popover-foreground shadow-md",
        className,
      )}
      {...props}
    />
  );
}

export {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
  HoverCardHeader,
  HoverCardBody,
};
