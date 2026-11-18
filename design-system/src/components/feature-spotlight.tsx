import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { X } from "lucide-react";

import { Badge } from "./badge";
import { cn } from "../cn";

/**
 * A one-time callout pinned to a piece of UI, introducing a feature where the
 * user will find it. Opened by the product, not by a click, so it never steals
 * focus and never traps it. Built on Radix Popover: Escape and an outside
 * click both close it, and the caller decides what closing means. Title and
 * description wrap balanced and pretty so no line strands a single word.
 * Mark it new with `FeatureSpotlightBadge` above the title.
 */

const SpotlightTitleContext = React.createContext<string | undefined>(
  undefined,
);

function FeatureSpotlight(
  props: React.ComponentProps<typeof PopoverPrimitive.Root>,
) {
  return <PopoverPrimitive.Root data-slot="feature-spotlight" {...props} />;
}

/** Wraps the element the callout points at. */
function FeatureSpotlightAnchor(
  props: React.ComponentProps<typeof PopoverPrimitive.Anchor>,
) {
  return (
    <PopoverPrimitive.Anchor data-slot="feature-spotlight-anchor" {...props} />
  );
}

/**
 * The pointer from the card to its anchor, drawn pointing down. The stroke
 * continues the card's border down both edges; place it 1px into the card so
 * its base covers the border underneath and the two read as one outline.
 */
function FeatureSpotlightPointer({
  className,
  ...props
}: React.ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 14 7"
      width={14}
      height={7}
      data-slot="feature-spotlight-pointer"
      className={cn("overflow-visible", className)}
      aria-hidden
      {...props}
    >
      <path d="M0 0L7 7L14 0" className="fill-popover stroke-border" />
    </svg>
  );
}

function FeatureSpotlightArrow() {
  return (
    <PopoverPrimitive.Arrow asChild width={14} height={7}>
      <FeatureSpotlightPointer className="-translate-y-px" />
    </PopoverPrimitive.Arrow>
  );
}

/**
 * The card on its own, for callouts positioned by something other than the
 * Radix popover (a guided tour's coachmark). Titles inside it label it.
 */
function FeatureSpotlightCard({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const titleId = React.useId();
  return (
    <div
      data-slot="feature-spotlight-card"
      aria-labelledby={titleId}
      className={cn(
        "bg-popover text-popover-foreground relative flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg border p-4 shadow-md outline-hidden",
        className,
      )}
      {...props}
    >
      <SpotlightTitleContext.Provider value={titleId}>
        {children}
      </SpotlightTitleContext.Provider>
    </div>
  );
}

function FeatureSpotlightContent({
  className,
  side = "right",
  align = "start",
  sideOffset = 10,
  alignOffset = -8,
  onOpenAutoFocus,
  children,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="feature-spotlight-content"
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        onOpenAutoFocus={(event) => {
          onOpenAutoFocus?.(event);
          // Unprompted: moving focus would pull the keyboard out of whatever
          // the user was doing.
          event.preventDefault();
        }}
        asChild
        {...props}
      >
        <FeatureSpotlightCard
          className={cn(
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 origin-(--radix-popover-content-transform-origin)",
            className,
          )}
        >
          {children}
          <FeatureSpotlightArrow />
        </FeatureSpotlightCard>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

/** The "New" label above the title. A primary tint, so it doesn't compete with the primary action. */
function FeatureSpotlightBadge({
  className,
  children = "New",
  ...props
}: React.ComponentProps<typeof Badge>) {
  return (
    <Badge
      variant="outline"
      data-slot="feature-spotlight-badge"
      className={cn("border-primary/30 bg-primary/10 text-primary", className)}
      {...props}
    >
      {children}
    </Badge>
  );
}

function FeatureSpotlightTitle({
  className,
  ...props
}: React.ComponentProps<"h2">) {
  const id = React.useContext(SpotlightTitleContext);
  return (
    <h2
      id={id}
      data-slot="feature-spotlight-title"
      className={cn(
        "pr-6 text-sm font-semibold leading-snug text-balance",
        className,
      )}
      {...props}
    />
  );
}

function FeatureSpotlightDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="feature-spotlight-description"
      className={cn(
        "text-xs leading-relaxed text-pretty text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function FeatureSpotlightActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="feature-spotlight-actions"
      className={cn("mt-2 flex items-center gap-2", className)}
      {...props}
    />
  );
}

/** The corner X, as a plain button for a card outside the Radix popover. */
function FeatureSpotlightCloseButton({
  className,
  ...props
}: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      data-slot="feature-spotlight-close"
      aria-label="Close"
      className={cn(
        "absolute right-2 top-2 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    >
      <X className="size-3.5" aria-hidden />
    </button>
  );
}

/** The corner X. Closes through `onOpenChange(false)` like Escape does. */
function FeatureSpotlightClose(
  props: React.ComponentProps<typeof PopoverPrimitive.Close>,
) {
  return (
    <PopoverPrimitive.Close asChild>
      <FeatureSpotlightCloseButton {...props} />
    </PopoverPrimitive.Close>
  );
}

export {
  FeatureSpotlight,
  FeatureSpotlightAnchor,
  FeatureSpotlightContent,
  FeatureSpotlightTitle,
  FeatureSpotlightDescription,
  FeatureSpotlightActions,
  FeatureSpotlightClose,
  FeatureSpotlightBadge,
  FeatureSpotlightCard,
  FeatureSpotlightPointer,
  FeatureSpotlightCloseButton,
};
