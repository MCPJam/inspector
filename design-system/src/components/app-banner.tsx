import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { CircleAlert, X } from "lucide-react";

import { cn } from "../cn";
import { Button } from "./button";

/**
 * A full-width notice at the top of the app about the account or session, not
 * the page: a failed payment, an expired session. `prominent` asks the reader
 * to act; `quiet` only informs and should be dismissible. Text stays left
 * aligned and actions sit at the right edge, like every other toolbar.
 */
const appBannerVariants = cva("flex shrink-0 items-center border-b", {
  variants: {
    emphasis: {
      prominent: "gap-3 border-l-2 py-2 pl-3.5 pr-3 text-sm",
      quiet:
        "gap-2 border-border/60 py-1 pl-4 pr-3 text-xs text-muted-foreground",
    },
    tone: {
      warning: "",
      neutral: "",
    },
  },
  compoundVariants: [
    {
      emphasis: "prominent",
      tone: "warning",
      className: "border-b-warning/30 border-l-warning bg-warning/10",
    },
    {
      emphasis: "prominent",
      tone: "neutral",
      className: "border-b-border border-l-foreground/40 bg-background",
    },
  ],
  defaultVariants: { emphasis: "prominent", tone: "warning" },
});

type AppBannerProps = Omit<React.ComponentProps<"div">, "children"> &
  VariantProps<typeof appBannerVariants> & {
    children: React.ReactNode;
    /** Buttons for the fix. Quiet banners take none. */
    actions?: React.ReactNode;
    /** Shows a Dismiss button. Leave unset when the problem blocks work. */
    onDismiss?: () => void;
  };

function AppBanner({
  emphasis = "prominent",
  tone = "warning",
  className,
  children,
  actions,
  onDismiss,
  ...props
}: AppBannerProps) {
  const isQuiet = emphasis === "quiet";
  return (
    <div
      data-slot="app-banner"
      role={isQuiet ? "status" : "alert"}
      className={cn(appBannerVariants({ emphasis, tone }), className)}
      {...props}
    >
      {isQuiet ? (
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            tone === "warning" ? "bg-warning" : "bg-muted-foreground",
          )}
        />
      ) : (
        <CircleAlert
          aria-hidden
          className={cn(
            "size-4 shrink-0",
            tone === "warning" ? "text-warning" : "text-muted-foreground",
          )}
        />
      )}
      <span className={cn("text-pretty", !isQuiet && "text-foreground")}>
        {children}
      </span>
      {actions || onDismiss ? (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {actions}
          {onDismiss ? (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Dismiss"
              className="size-6"
              onClick={onDismiss}
            >
              <X className="size-3.5" />
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export { AppBanner, appBannerVariants };
