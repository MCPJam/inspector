import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { cn } from "../cn";

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  );
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

type TooltipContentProps = React.ComponentProps<
  typeof TooltipPrimitive.Content
> & {
  /**
   * `muted` uses popover/surface colors for hints so they don't read as a
   * primary (CTA) action. `default` keeps the branded primary pill.
   */
  variant?: "default" | "muted";
};

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  variant = "default",
  ...props
}: TooltipContentProps) {
  const isMuted = variant === "muted";
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) rounded-md px-3 py-1.5 text-xs",
          isMuted
            ? "border border-border bg-popover text-popover-foreground shadow-md"
            : "bg-primary text-primary-foreground",
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow
          className={cn(
            "z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]",
            isMuted ? "fill-popover" : "bg-primary fill-primary",
          )}
        />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

/**
 * Says why a control is disabled. A disabled button gets no hover and no
 * focus, so a focusable span carries the tooltip for mouse and keyboard
 * alike. Without a `reason` the control keeps its plain `fallback` tooltip,
 * or renders as is.
 */
function DisabledReasonTooltip({
  reason,
  fallback,
  children,
  ...contentProps
}: Omit<TooltipContentProps, "children"> & {
  reason?: React.ReactNode;
  fallback?: React.ReactNode;
  children: React.ReactElement;
}) {
  const content = reason || fallback;
  if (!content) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {reason ? (
          <span
            className="inline-flex rounded-md outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            tabIndex={0}
          >
            {children}
          </span>
        ) : (
          children
        )}
      </TooltipTrigger>
      <TooltipContent {...contentProps}>{content}</TooltipContent>
    </Tooltip>
  );
}

export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
  DisabledReasonTooltip,
};
