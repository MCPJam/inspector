import * as React from "react";

import { cn } from "../cn";

/** Shared bento tile: a bordered muted surface with an optional caption strip underneath. */
function BentoTile({
  title,
  kicker,
  children,
  className,
  viewportClassName,
  titleId,
}: {
  title?: string;
  kicker?: string;
  children: React.ReactNode;
  className?: string;
  viewportClassName?: string;
  titleId?: string;
}) {
  return (
    <div
      data-slot="bento-tile"
      className={cn(
        "group relative flex h-full flex-col overflow-hidden rounded-lg border border-border bg-muted/40",
        className
      )}
    >
      <div
        data-slot="bento-tile-viewport"
        className={cn(
          "relative flex min-h-0 flex-1 flex-col overflow-hidden",
          viewportClassName
        )}
      >
        {children}
      </div>
      {kicker || title ? (
        <div className="relative border-t border-border/70 bg-background/40 px-6 py-5">
          {kicker ? (
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
              {kicker}
            </span>
          ) : null}
          {title ? (
            <h3
              id={titleId}
              className="mt-1 text-lg font-medium tracking-tight text-foreground"
            >
              {title}
            </h3>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export { BentoTile };
