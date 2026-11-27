import { Fragment, type ReactNode } from "react";
import { cn } from "@mcpjam/design-system/cn";
import { PAGE_HEADER_STRIP_CLASSNAME } from "@/components/shared/landing-page-header";

export type TourCrumb = { label: string; anchor?: string };

/**
 * The detail-page trail the real Evaluate header draws ("Evaluate / suite /
 * page"), as static markup for the tour's example screens.
 */
export function TourBreadcrumb({
  crumbs,
  trailing,
}: {
  crumbs: readonly TourCrumb[];
  trailing?: ReactNode;
}) {
  return (
    <div
      className={cn(
        PAGE_HEADER_STRIP_CLASSNAME,
        "flex items-center justify-between gap-3 py-3",
      )}
    >
      <nav className="flex min-w-0 items-center gap-1.5 text-sm">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <Fragment key={`${crumb.label}-${index}`}>
              {index > 0 ? (
                <span className="text-muted-foreground">/</span>
              ) : null}
              <span
                data-tour-anchor={crumb.anchor}
                className={cn(
                  "truncate",
                  last
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {crumb.label}
              </span>
            </Fragment>
          );
        })}
      </nav>
      {trailing ? (
        <div className="flex shrink-0 items-center gap-2">{trailing}</div>
      ) : null}
    </div>
  );
}

export function ExampleDataPill() {
  return (
    <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-foreground">
      Example data
    </span>
  );
}

/** A button-shaped label; the tour's screens are pictures, not controls. */
export function FakeButton({
  children,
  variant = "outline",
  anchor,
  className,
}: {
  children: ReactNode;
  variant?: "outline" | "primary" | "primary-muted";
  anchor?: string;
  className?: string;
}) {
  return (
    <span
      data-tour-anchor={anchor}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium",
        variant === "outline" &&
          "border border-border bg-background text-foreground",
        variant === "primary" && "bg-primary text-primary-foreground",
        variant === "primary-muted" && "bg-primary/50 text-primary-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusTag({ status }: { status: "passed" | "failed" }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        status === "failed"
          ? "bg-destructive/10 text-destructive"
          : "bg-success/15 text-success",
      )}
    >
      {status}
    </span>
  );
}
