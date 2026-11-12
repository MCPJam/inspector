/**
 * The full-page frame and shared pieces of first-run onboarding: the linen
 * chrome with an off-white working panel (DESIGN.md, Layout), the server tile,
 * the step heading, and the bottom "Skip for now" row.
 *
 * Pure presentation. The overlay owns every piece of state.
 */
import type { ReactNode } from "react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { DialogDescription, DialogTitle } from "@mcpjam/design-system/dialog";

const DOCS_URL = "https://docs.mcpjam.com";

export function FirstRunFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between px-5">
        <div className="flex items-center gap-2.5">
          <img
            src="/mcp_jam.svg"
            alt=""
            aria-hidden
            className="size-7 shrink-0"
          />
          <span className="text-base font-semibold tracking-tight">MCPJam</span>
        </div>
        <Button asChild variant="ghost">
          <a href={DOCS_URL} target="_blank" rel="noreferrer">
            Docs
          </a>
        </Button>
      </header>
      <div className="mx-2 mb-2 min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-background">
        <div className="mx-auto w-full max-w-xl px-4 pt-12 pb-16 sm:px-6 sm:pt-24">
          {children}
        </div>
      </div>
    </div>
  );
}

export function FirstRunHeading({
  title,
  description,
  tile,
}: {
  title: ReactNode;
  description?: ReactNode;
  tile?: ReactNode;
}) {
  return (
    <div className={cn(tile && "flex items-center gap-4")}>
      {tile}
      <div className="min-w-0">
        <DialogTitle
          className={cn(
            "font-semibold tracking-tight text-foreground",
            tile ? "text-2xl" : "text-3xl",
          )}
        >
          {title}
        </DialogTitle>
        {description ? (
          <DialogDescription
            className={
              tile
                ? "mt-0.5 truncate font-mono text-sm text-muted-foreground"
                : "mt-3 max-w-prose text-base leading-relaxed text-foreground"
            }
          >
            {description}
          </DialogDescription>
        ) : null}
      </div>
    </div>
  );
}

/** A square initial for the server being connected, with an optional status dot. */
export function ServerTile({
  name,
  connected = false,
  animate = false,
}: {
  name: string;
  connected?: boolean;
  animate?: boolean;
}) {
  const initial = name.trim().charAt(0).toUpperCase() || "S";
  return (
    <div
      aria-hidden
      className="relative flex size-11 shrink-0 items-center justify-center rounded-lg bg-foreground text-xl font-semibold text-background"
    >
      {initial}
      {connected ? (
        <span
          data-testid="first-run-success-indicator"
          className={cn(
            "absolute -right-1 -bottom-1 size-3.5 rounded-full border-[3px] border-background bg-success",
            animate && "animate-in fade-in zoom-in-50 duration-500",
          )}
        />
      ) : null}
    </div>
  );
}

export function FirstRunSkipRow({ onSkip }: { onSkip: () => void }) {
  return (
    <div className="mt-10 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-6 text-base">
      <span className="text-muted-foreground">
        Not ready to connect a server?
      </span>
      <Button
        type="button"
        variant="link"
        className="h-auto px-1 py-2 text-base text-foreground underline decoration-input underline-offset-4"
        onClick={onSkip}
      >
        Skip for now
      </Button>
    </div>
  );
}
