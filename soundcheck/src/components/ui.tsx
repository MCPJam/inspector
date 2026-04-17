/**
 * Shared UI primitives for Soundcheck tiles. Editorial-meets-ops aesthetic:
 * warm off-black panels with a hairline edge, display serif for numbers and
 * verdicts, Geist for body, Geist Mono for SHAs. Status tone is carried via
 * `.panel-accent-*` on the left edge of tiles and the `.dot-*` glow primitives.
 */

import type { ReactNode } from "react";

export type StatusTone =
  | "success"
  | "failure"
  | "warning"
  | "info"
  | "running"
  | "neutral";

const PANEL_ACCENT: Record<StatusTone, string> = {
  success: "panel-accent-go",
  failure: "panel-accent-stop",
  warning: "panel-accent-wait",
  info: "panel-accent-info",
  running: "panel-accent-info",
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
    <section
      className={`panel ${PANEL_ACCENT[accent]} p-6 relative overflow-hidden`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {eyebrow ? (
            <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-500">
              {eyebrow}
            </div>
          ) : null}
          <h3 className="text-[15px] font-medium text-ink-100">{title}</h3>
        </div>
        {action ? (
          <div className="shrink-0 text-xs text-ink-400">{action}</div>
        ) : null}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * A numbered editorial section header. Roman numeral dropcap + display-serif
 * title + muted description. Creates rhythm down the page.
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
    <section className="mb-14 animate-fade-up">
      <header className="mb-5 flex items-baseline gap-4">
        <span className="numeral select-none w-8 shrink-0 text-right">
          {numeral}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="display-hero text-[1.65rem] text-ink-100">{title}</h2>
          {description ? (
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-400">
              {description}
            </p>
          ) : null}
        </div>
      </header>
      <div className="pl-0 md:pl-12">{children}</div>
    </section>
  );
}

const DOT_CLASSES: Record<StatusTone, string> = {
  success: "dot dot-go",
  failure: "dot dot-stop",
  warning: "dot dot-wait",
  info: "dot dot-info",
  running: "dot dot-run",
  neutral: "dot dot-neutral"
};

export function StatusDot({ tone }: { tone: StatusTone }) {
  return <span className={DOT_CLASSES[tone]} aria-hidden />;
}

const BADGE_CLASSES: Record<StatusTone, string> = {
  success:
    "bg-signal-go/10 text-signal-go ring-1 ring-inset ring-signal-go/25",
  failure:
    "bg-signal-stop/10 text-signal-stop ring-1 ring-inset ring-signal-stop/30",
  warning:
    "bg-signal-wait/10 text-signal-wait ring-1 ring-inset ring-signal-wait/30",
  info:
    "bg-signal-info/10 text-signal-info ring-1 ring-inset ring-signal-info/25",
  running:
    "bg-signal-info/10 text-signal-info ring-1 ring-inset ring-signal-info/25",
  neutral:
    "bg-ink-800 text-ink-300 ring-1 ring-inset ring-ink-700"
};

export function Badge({
  tone,
  children
}: {
  tone: StatusTone;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] ${BADGE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Big editorial number — used for hero stats like "251 commits behind".
 * Intentionally huge, intentionally italic-serif. Signals "this is the
 * headline answer on this tile."
 */
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
  const toneClass =
    tone === "success"
      ? "text-signal-go"
      : tone === "failure"
        ? "text-signal-stop"
        : tone === "warning"
          ? "text-signal-wait"
          : tone === "info" || tone === "running"
            ? "text-signal-info"
            : "text-ink-100";
  const num = (
    <span className={`display-hero text-6xl md:text-7xl ${toneClass}`}>
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
        <div className="text-sm font-medium text-ink-100">{label}</div>
        {sublabel ? (
          <div className="mt-0.5 text-xs text-ink-400">{sublabel}</div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The page-level verdict strip. Answers "can I ship right now?" in one glance,
 * before the operator has to read anything else.
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
  const accent = PANEL_ACCENT[tone];
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
    <div className={`panel ${accent} px-6 py-5 md:px-8 md:py-6`}>
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-4">
          <StatusDot tone={tone} />
          <div>
            <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-ink-500">
              Release verdict
            </div>
            <div className="mt-0.5 flex items-baseline gap-3">
              <span className="display-hero text-2xl md:text-3xl text-ink-100">
                {label}.
              </span>
              <span className="text-sm text-ink-200">{headline}</span>
            </div>
          </div>
        </div>
        <p className="max-w-md text-xs leading-relaxed text-ink-400 md:text-right">
          {detail}
        </p>
      </div>
    </div>
  );
}

/**
 * Inline SHA link — styled as a small mono tag, hover underline.
 */
export function Sha({ href, sha }: { href?: string; sha: string }) {
  if (!href) return <span className="tag-mono">{sha}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="tag-mono hover:text-ink-100 hover:underline underline-offset-4 decoration-ink-600"
    >
      {sha}
    </a>
  );
}

/**
 * Link action for tile top-right. Small, understated, with a trailing arrow.
 */
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
      className="inline-flex items-center gap-1 text-xs text-ink-400 transition-colors hover:text-ink-100"
    >
      {children}
      <span className="text-ink-500">↗</span>
    </a>
  );
}
