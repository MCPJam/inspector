/** Small presentational pieces shared by the platform widget views. */
import type { App } from "@modelcontextprotocol/ext-apps";
import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@mcpjam/design-system/cn";
import { Check, Copy, ExternalLink } from "lucide-react";
import { type MouseEvent, type ReactNode, useState } from "react";
import { McpJamLogo } from "../shared/app-shell.js";
import { humanizeStatus, normalizeRate } from "../shared/format.js";

export function ViewHeader({
  title,
  accessory,
  badgeLabel,
  caption,
  isDark,
}: {
  title: string;
  accessory?: ReactNode;
  badgeLabel?: string;
  caption?: ReactNode;
  isDark: boolean;
}) {
  return (
    <header className="flex items-start justify-between gap-4 pb-1">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="break-words text-xl font-semibold leading-tight sm:text-2xl">
            {title}
          </h1>
          {badgeLabel ? (
            <Badge variant="secondary" className="shrink-0">
              {badgeLabel}
            </Badge>
          ) : null}
          {accessory}
        </div>
        {caption ? (
          <div className="break-words text-sm text-muted-foreground">
            {caption}
          </div>
        ) : null}
      </div>
      <McpJamLogo isDark={isDark} />
    </header>
  );
}

type EvalOutcome = {
  label: string;
  dotClass: string;
  pulse?: boolean;
};

/**
 * One verdict from the status/result pair: the terminal `result` wins, then
 * terminal statuses, then anything else reads as in-flight.
 */
export function getEvalOutcome(
  status: string | null | undefined,
  result?: string | null
): EvalOutcome {
  if (result === "passed") {
    return { label: "Passed", dotClass: "bg-emerald-500" };
  }
  if (result === "failed") {
    return { label: "Failed", dotClass: "bg-red-500" };
  }

  switch (status) {
    case "completed":
      return { label: "Completed", dotClass: "bg-emerald-500" };
    case "failed":
      return { label: "Failed", dotClass: "bg-red-500" };
    case "cancelled":
    case "canceled":
      return { label: "Cancelled", dotClass: "bg-muted-foreground/55" };
    case null:
    case undefined:
    case "":
      return { label: "Unknown", dotClass: "bg-muted-foreground/55" };
    default:
      return {
        label: humanizeStatus(status),
        dotClass: "bg-amber-500",
        pulse: true,
      };
  }
}

export function OutcomeBadge({
  status,
  result,
  bare = false,
}: {
  status: string | null | undefined;
  result?: string | null;
  bare?: boolean;
}) {
  const outcome = getEvalOutcome(status, result);

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground",
        !bare && "rounded-md border border-border/60 px-2 py-1"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          outcome.dotClass,
          outcome.pulse && "animate-pulse"
        )}
      />
      {outcome.label}
    </span>
  );
}

/** Inline pass-rate trend, oldest to newest; hidden until two data points. */
export function PassRateSparkline({ trend }: { trend: number[] }) {
  const rates = trend
    .map((value) => normalizeRate(value))
    .filter((value): value is number => value !== undefined);
  if (rates.length < 2) {
    return null;
  }

  const width = 96;
  const height = 28;
  const pad = 3;
  const points = rates
    .map((rate, index) => {
      const x = pad + (index * (width - 2 * pad)) / (rates.length - 1);
      const y = pad + (1 - rate) * (height - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const [lastX = "0", lastY = "0"] = points.split(" ").at(-1)!.split(",");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-7 w-24 shrink-0 text-muted-foreground/70"
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={lastX} cy={lastY} r="2" className="fill-current" />
    </svg>
  );
}

export function CopyIconButton({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copyValue = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();

    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.error(error);
    }
  };

  return (
    <button
      aria-label={label}
      title={label}
      type="button"
      onClick={copyValue}
      className={cn(
        "cursor-pointer p-1 text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

/** Opens a URL through the host; renders nothing when the host can't. */
export function OpenLinkButton({
  app,
  url,
  label,
  className,
}: {
  app: App | undefined;
  url: string;
  label: string;
  className?: string;
}) {
  if (!app?.getHostCapabilities()?.openLinks) {
    return null;
  }

  return (
    <button
      aria-label={label}
      title={label}
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        app.openLink({ url }).catch(console.error);
      }}
      className={cn(
        "cursor-pointer p-1 text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      <ExternalLink className="h-3 w-3" />
    </button>
  );
}

export function StatTile({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-muted/30 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function SectionCard({
  title,
  badgeLabel,
  children,
}: {
  title: string;
  badgeLabel?: string;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border/60 bg-card/60">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <h2 className="truncate text-sm font-semibold">{title}</h2>
        {badgeLabel ? <Badge variant="secondary">{badgeLabel}</Badge> : null}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}
