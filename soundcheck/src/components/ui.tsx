/**
 * Shared UI primitives for Soundcheck tiles. Keep this tiny — it's only here
 * because the same `<Tile>` shell is now used by 5+ components, and the
 * status dots / badges / monospace commits need to render identically across
 * readiness, progress, failures, and deploy-diff.
 */

import type { ReactNode } from "react";

export function Tile({
  title,
  action,
  children
}: {
  title: string;
  /** Optional top-right content (usually a "View in GitHub" link). */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-6 bg-white/0">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
          {title}
        </h3>
        {action ? (
          <div className="text-xs text-neutral-400">{action}</div>
        ) : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function Section({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-10">
      <div className="mb-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
          {title}
        </h2>
        {description ? (
          <p className="mt-1 text-xs text-neutral-500">{description}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export type StatusTone = "success" | "failure" | "warning" | "info" | "running" | "neutral";

const DOT_CLASSES: Record<StatusTone, string> = {
  success: "bg-emerald-500",
  failure: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-sky-500",
  running: "bg-sky-500 animate-pulse",
  neutral: "bg-neutral-400 dark:bg-neutral-600"
};

export function StatusDot({ tone }: { tone: StatusTone }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${DOT_CLASSES[tone]}`}
      aria-hidden
    />
  );
}

const BADGE_CLASSES: Record<StatusTone, string> = {
  success: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  failure: "bg-red-500/10 text-red-700 dark:text-red-400",
  warning: "bg-amber-500/10 text-amber-700 dark:text-amber-500",
  info: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  running: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  neutral: "bg-neutral-200/60 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
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
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${BADGE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}
