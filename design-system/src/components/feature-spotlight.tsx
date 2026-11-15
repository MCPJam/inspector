import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { X } from "lucide-react";

import { cn } from "../cn";

/**
 * A one-time callout pinned to a piece of UI, introducing a feature where the
 * user will find it. Opened by the product, not by a click, so it never steals
 * focus and never traps it. Built on Radix Popover: Escape and an outside
 * click both close it, and the caller decides what closing means.
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

function FeatureSpotlightArrow() {
  // Drawn rather than Radix's default triangle so the card's border continues
  // down both edges. The 1px lift covers the card's own border under the
  // arrow's base, which is what joins the two into one outline.
  return (
    <PopoverPrimitive.Arrow asChild width={14} height={7}>
      <svg
        viewBox="0 0 14 7"
        className="-translate-y-px overflow-visible"
        aria-hidden
      >
        <path d="M0 0L7 7L14 0" className="fill-popover stroke-border" />
      </svg>
    </PopoverPrimitive.Arrow>
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
  const titleId = React.useId();
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="feature-spotlight-content"
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        aria-labelledby={titleId}
        onOpenAutoFocus={(event) => {
          onOpenAutoFocus?.(event);
          // Unprompted: moving focus would pull the keyboard out of whatever
          // the user was doing.
          event.preventDefault();
        }}
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative z-50 flex w-80 max-w-[calc(100vw-2rem)] origin-(--radix-popover-content-transform-origin) flex-col gap-2 rounded-lg border p-4 shadow-md outline-hidden",
          className,
        )}
        {...props}
      >
        <SpotlightTitleContext.Provider value={titleId}>
          {children}
        </SpotlightTitleContext.Provider>
        <FeatureSpotlightArrow />
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

/** A small pill above the title, e.g. "New". */
function FeatureSpotlightEyebrow({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="feature-spotlight-eyebrow"
      className={cn(
        "w-fit rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium leading-none text-foreground",
        className,
      )}
      {...props}
    />
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
      className={cn("pr-6 text-sm font-semibold leading-snug", className)}
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
      className={cn("text-xs leading-relaxed text-muted-foreground", className)}
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

/** The corner X. Closes through `onOpenChange(false)` like Escape does. */
function FeatureSpotlightClose({
  className,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Close>) {
  return (
    <PopoverPrimitive.Close
      data-slot="feature-spotlight-close"
      aria-label="Close"
      className={cn(
        "absolute right-2 top-2 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    >
      <X className="size-3.5" aria-hidden />
    </PopoverPrimitive.Close>
  );
}

export {
  FeatureSpotlight,
  FeatureSpotlightAnchor,
  FeatureSpotlightContent,
  FeatureSpotlightEyebrow,
  FeatureSpotlightTitle,
  FeatureSpotlightDescription,
  FeatureSpotlightActions,
  FeatureSpotlightClose,
};
