// Tier-A primitives for the trace timeline.
//
// The inspector's trace-timeline pulled these from `@mcpjam/design-system`
// (Button/Badge/ScrollArea) and `@/components/ui/resizable`, both of which are
// forbidden / unresolvable inside this provider-free package. These are minimal
// drop-ins covering exactly the prop surface the timeline uses. The panel shims
// render a STATIC vertical split (no drag) — the read-only timeline only needs
// the layout proportions, not interactive resizing.

import type {
  ButtonHTMLAttributes,
  CSSProperties,
  ReactNode,
} from "react";
import { cn } from "../cn";

type ButtonVariant = "secondary" | "outline";
type ButtonSize = "sm" | "icon" | "default";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  outline: "border border-border bg-transparent hover:bg-muted/50",
  secondary: "bg-muted text-foreground hover:bg-muted/80",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  icon: "h-8 w-8",
  default: "h-9 px-4 text-sm",
};

export function Button({
  variant = "outline",
  size = "default",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      className={cn(
        BUTTON_BASE,
        BUTTON_VARIANT[variant],
        BUTTON_SIZE[size],
        className,
      )}
      {...rest}
    />
  );
}

export function Badge({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs font-medium",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function ScrollArea({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  // `overflow-auto` LAST so it wins the tailwind-merge conflict: callers (e.g.
  // the timeline in fillContent mode) pass `overflow-hidden` expecting the
  // design-system ScrollArea's separate scrollable viewport. This shim is a
  // single element, so it must stay the scroll container itself — otherwise the
  // caller's `overflow-hidden` would clip the waterfall with no way to scroll.
  return <div className={cn(className, "overflow-auto")}>{children}</div>;
}

export function ResizablePanelGroup({
  direction,
  className,
  style,
  children,
}: {
  direction: "vertical" | "horizontal";
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0",
        direction === "vertical" ? "flex-col" : "flex-row",
        className,
      )}
      style={style}
    >
      {children}
    </div>
  );
}

export function ResizablePanel({
  defaultSize = 50,
  className,
  children,
}: {
  // `minSize` is accepted for API parity but unused (static split).
  defaultSize?: number;
  minSize?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn("min-h-0 min-w-0", className)}
      // flexBasis 'auto' (not 0): in a fixed-height parent (fillContent) flexGrow
      // splits the free space proportionally; in an auto-height parent (the
      // common embed) the panels size to their content and stack instead of
      // collapsing to nothing (flexBasis 0 + no free space → zero height).
      style={{ flexGrow: defaultSize, flexShrink: 1, flexBasis: "auto" }}
    >
      {children}
    </div>
  );
}

export function ResizableHandle({ withHandle: _withHandle }: { withHandle?: boolean }) {
  return <div className="h-px w-full shrink-0 bg-border" aria-hidden />;
}
