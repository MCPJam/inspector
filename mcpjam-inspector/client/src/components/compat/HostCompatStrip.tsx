import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ServerWithName } from "@/state/app-types";
import { useHostCompatReports } from "@/lib/host-compat/use-host-compat";
import type { CompatVerdict, HostCompatReport } from "@/lib/host-compat/types";
import type { HostThemeMode } from "@/lib/client-styles";

const VERDICT_DOT_CLASS: Record<CompatVerdict, string> = {
  works: "bg-emerald-500",
  degraded: "bg-amber-500",
  blocked: "bg-red-500",
  unknown: "bg-muted-foreground/40",
};

const VERDICT_LABEL: Record<CompatVerdict, string> = {
  works: "Works",
  degraded: "Degraded",
  blocked: "Blocked",
  unknown: "Unknown",
};

export function summarizeReports(reports: HostCompatReport[]): string {
  if (reports.length === 0) return "checking…";
  const counts = reports.reduce(
    (acc, report) => {
      acc[report.verdict] += 1;
      return acc;
    },
    { works: 0, degraded: 0, blocked: 0, unknown: 0 }
  );
  const parts: string[] = [];
  if (counts.works > 0) parts.push(`works in ${counts.works}`);
  if (counts.degraded > 0) parts.push(`degraded in ${counts.degraded}`);
  if (counts.blocked > 0) parts.push(`blocked in ${counts.blocked}`);
  // Surface unknowns only when no host produced a definite verdict —
  // otherwise the grey dots already carry it and a roll-up would just add
  // noise. An all-unknown result is a real state (incomplete connect data),
  // not "still checking".
  if (parts.length === 0 && counts.unknown > 0) {
    return `unknown in ${counts.unknown}`;
  }
  return parts.join(" · ");
}

function readPx(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function useSummaryFits(summary: string) {
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const iconsRef = useRef<HTMLDivElement>(null);
  const summaryMeasureRef = useRef<HTMLSpanElement>(null);
  const [showSummary, setShowSummary] = useState(true);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const button = buttonRef.current;
    const icons = iconsRef.current;
    const summaryMeasure = summaryMeasureRef.current;
    if (!container || !button || !icons || !summaryMeasure) return;

    let frame = 0;
    const measure = () => {
      const availableWidth = container.getBoundingClientRect().width;
      const iconWidth = icons.getBoundingClientRect().width;
      const summaryWidth = summaryMeasure.getBoundingClientRect().width;

      if (availableWidth <= 0 || iconWidth <= 0 || summaryWidth <= 0) {
        setShowSummary(true);
        return;
      }

      const styles = window.getComputedStyle(button);
      const horizontalChrome =
        readPx(styles.paddingLeft) +
        readPx(styles.paddingRight) +
        readPx(styles.borderLeftWidth) +
        readPx(styles.borderRightWidth);
      const gap = readPx(styles.columnGap || styles.gap);
      const requiredWidth = iconWidth + summaryWidth + horizontalChrome + gap;

      setShowSummary((current) => {
        const next = requiredWidth <= availableWidth;
        return current === next ? current : next;
      });
    };

    const scheduleMeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    scheduleMeasure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", scheduleMeasure);
      return () => {
        cancelAnimationFrame(frame);
        window.removeEventListener("resize", scheduleMeasure);
      };
    }

    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(container);
    observer.observe(icons);
    observer.observe(summaryMeasure);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [summary]);

  return {
    containerRef,
    buttonRef,
    iconsRef,
    summaryMeasureRef,
    showSummary,
  };
}

/**
 * Presentational compat strip — a row of host logos with verdict dots and a
 * one-line summary. Split from the data-fetching wrapper so it can be
 * rendered from pre-evaluated reports (e.g. the detail modal, prototype
 * harnesses) without re-fetching tools.
 */
export function HostCompatStripView({
  serverName,
  reports,
  onOpenDetails,
  themeMode = "light",
}: {
  serverName: string;
  reports: HostCompatReport[];
  onOpenDetails?: () => void;
  themeMode?: HostThemeMode;
}) {
  const summary = useMemo(() => summarizeReports(reports), [reports]);
  const {
    containerRef,
    buttonRef,
    iconsRef,
    summaryMeasureRef,
    showSummary,
  } = useSummaryFits(summary);

  return (
    <div
      ref={containerRef}
      data-server-card-context-menu-exempt
      className="flex min-w-0 flex-1 items-center gap-2"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={onOpenDetails}
        disabled={!onOpenDetails}
        aria-label={`Host compatibility for ${serverName}`}
        className="relative inline-flex max-w-full flex-nowrap items-center gap-1.5 rounded-full border border-border/70 bg-muted/30 px-2 py-0.5 transition-colors hover:bg-accent/60 cursor-pointer disabled:cursor-default"
      >
        <div ref={iconsRef} className="flex shrink-0 items-center gap-1">
          {reports.map((report) => (
            <Tooltip key={report.hostId}>
              <TooltipTrigger asChild>
                <span className="relative inline-flex h-4 w-4 items-center justify-center">
                  <img
                    src={report.logoSrcByTheme?.[themeMode] ?? report.logoSrc}
                    alt={report.hostLabel}
                    className="h-3.5 w-3.5 rounded-[3px] object-contain"
                  />
                  <span
                    className={`absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-background ${
                      VERDICT_DOT_CLASS[report.verdict]
                    }`}
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                sideOffset={4}
                variant="muted"
                className="max-w-56 px-2.5 text-left [text-wrap:normal]"
              >
                <span className="font-medium">
                  {report.hostLabel}: {VERDICT_LABEL[report.verdict]}
                </span>
                {report.findings[0] ? (
                  <>
                    {" — "}
                    {report.findings[0].title}
                    {report.findings.length > 1
                      ? ` (+${report.findings.length - 1} more)`
                      : ""}
                  </>
                ) : report.verdict === "works" ? (
                  " — all checks passed"
                ) : null}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
        <span
          ref={summaryMeasureRef}
          aria-hidden="true"
          className="pointer-events-none absolute h-0 overflow-hidden whitespace-nowrap text-[11px] opacity-0"
        >
          {summary}
        </span>
        {showSummary && (
          <span className="whitespace-nowrap text-[11px] text-muted-foreground">
            {summary}
          </span>
        )}
      </button>
    </div>
  );
}

/**
 * Compact per-host compatibility row for the server connection card —
 * the "from the moment you connect" surface of the host-compat design
 * (design-explorations/host-compat-report.md). Clicking opens the detail
 * modal's Compatibility tab.
 */
export function HostCompatStrip({
  server,
  onOpenDetails,
}: {
  server: ServerWithName;
  onOpenDetails?: () => void;
}) {
  const { reports } = useHostCompatReports(server);
  return (
    <HostCompatStripView
      serverName={server.name}
      reports={reports}
      onOpenDetails={onOpenDetails}
    />
  );
}
