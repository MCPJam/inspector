/**
 * Shared Soundcheck primitives. Thin wrappers over @mcpjam/design-system
 * shadcn components — adds the tile/verdict/tone vocabulary Soundcheck uses
 * (`StatusTone` carries "can we ship?" semantics) while delegating the
 * actual rendering to the shared design system.
 */

import type { ReactNode } from "react";
import { cn } from "@mcpjam/design-system/cn";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle
} from "@mcpjam/design-system/card";
import { Badge as DsBadge } from "@mcpjam/design-system/badge";

export type StatusTone =
  | "success"
  | "failure"
  | "warning"
  | "info"
  | "running"
  | "neutral";

const ACCENT_BORDER: Record<StatusTone, string> = {
  success: "border-l-4 border-l-success",
  failure: "border-l-4 border-l-destructive",
  warning: "border-l-4 border-l-warning",
  info: "border-l-4 border-l-info",
  running: "border-l-4 border-l-info",
  neutral: ""
};

export function Tile({
  title,
  eyebrow,
  action,
  accent = "neutral",
  children
}: {
  title: string;
  /** Optional short label above the title, uppercase + tracked. */
  eyebrow?: string;
  /** Top-right content (usually a "View ↗" link). */
  action?: ReactNode;
  /** Tone strip on the left edge; carries the tile's overall status signal. */
  accent?: StatusTone;
  children: ReactNode;
}) {
  return (
    <Card className={cn("gap-4 py-5 overflow-hidden", ACCENT_BORDER[accent])}>
      <CardHeader className="px-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {eyebrow ? (
              <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {eyebrow}
              </div>
            ) : null}
            <CardTitle className="text-[15px]">{title}</CardTitle>
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      </CardHeader>
      <CardContent className="px-5">{children}</CardContent>
    </Card>
  );
}

/**
 * Page-level section with a numbered label, title, and description.
 * Purely structural — no editorial typography.
 */
export function Section({
  numeral,
  title,
  description,
  children
}: {
  numeral: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-12">
      <header className="mb-5">
        <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Section {numeral}
        </div>
        <h2 className="mt-1.5 text-xl font-semibold text-foreground">{title}</h2>
        {description ? (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </header>
      {children}
    </section>
  );
}

const DOT_BG: Record<StatusTone, string> = {
  success: "bg-success",
  failure: "bg-destructive",
  warning: "bg-warning",
  info: "bg-info",
  running: "bg-info animate-pulse",
  neutral: "bg-muted-foreground/40"
};

export function StatusDot({ tone }: { tone: StatusTone }) {
  return (
    <span
      className={cn("inline-block size-2 rounded-full", DOT_BG[tone])}
      aria-hidden
    />
  );
}

const BADGE_TONE: Record<StatusTone, string> = {
  success: "bg-success/15 text-success border-success/30",
  failure: "bg-destructive/15 text-destructive border-destructive/40",
  warning: "bg-warning/15 text-warning border-warning/40",
  info: "bg-info/15 text-info border-info/30",
  running: "bg-info/15 text-info border-info/30",
  neutral: "bg-muted text-muted-foreground border-border"
};

export function Badge({
  tone,
  children
}: {
  tone: StatusTone;
  children: ReactNode;
}) {
  return (
    <DsBadge
      variant="outline"
      className={cn(
        "font-mono text-[10px] uppercase tracking-[0.08em] rounded-full",
        BADGE_TONE[tone]
      )}
    >
      {children}
    </DsBadge>
  );
}

const HERO_TONE: Record<StatusTone, string> = {
  success: "text-success",
  failure: "text-destructive",
  warning: "text-warning",
  info: "text-info",
  running: "text-info",
  neutral: "text-foreground"
};

export function HeroStat({
  value,
  tone = "neutral",
  label,
  sublabel,
  href
}: {
  value: string | number;
  tone?: StatusTone;
  label: string;
  sublabel?: ReactNode;
  href?: string;
}) {
  const num = (
    <span
      className={cn(
        "text-5xl md:text-6xl font-semibold tabular-nums tracking-tight",
        HERO_TONE[tone]
      )}
    >
      {value}
    </span>
  );
  return (
    <div className="flex items-end gap-4">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="transition-opacity hover:opacity-80"
        >
          {num}
        </a>
      ) : (
        num
      )}
      <div className="pb-2">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {sublabel ? (
          <div className="mt-0.5 text-xs text-muted-foreground">{sublabel}</div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Page-level verdict strip — "Go / Hold / Caution / In flight" in one glance.
 */
export function Verdict({
  tone,
  headline,
  detail
}: {
  tone: StatusTone;
  headline: string;
  detail: string;
}) {
  const label =
    tone === "success"
      ? "Go"
      : tone === "failure"
        ? "Hold"
        : tone === "warning"
          ? "Caution"
          : tone === "running"
            ? "In flight"
            : "Check";
  return (
    <Card className={cn("py-5", ACCENT_BORDER[tone])}>
      <CardContent className="px-5 md:px-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-4">
            <StatusDot tone={tone} />
            <div>
              <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                Release verdict
              </div>
              <div className="mt-0.5 flex items-baseline gap-3">
                <span
                  className={cn(
                    "text-2xl md:text-3xl font-semibold tracking-tight",
                    HERO_TONE[tone]
                  )}
                >
                  {label}.
                </span>
                <span className="text-sm text-foreground">{headline}</span>
              </div>
            </div>
          </div>
          <p className="max-w-md text-xs leading-relaxed text-muted-foreground md:text-right">
            {detail}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/** Inline SHA link. Renders as a small mono tag; underlines on hover when linked. */
export function Sha({ href, sha }: { href?: string; sha: string }) {
  if (!href) {
    return <span className="font-mono text-xs text-muted-foreground">{sha}</span>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-xs text-muted-foreground hover:text-foreground hover:underline underline-offset-4"
    >
      {sha}
    </a>
  );
}

/** Tile top-right action — small link with a trailing arrow. */
export function TileAction({
  href,
  children
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      {children}
      <span className="opacity-60">↗</span>
    </a>
  );
}
