import { useLayoutEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import type { ServerWithName } from "@/state/app-types";
import { useHostCompatReports } from "@/lib/host-compat/use-host-compat";
import type { HostCompatReport } from "@/lib/host-compat/types";
import type { HostThemeMode } from "@/lib/client-styles";
import {
  COMPAT_DISPLAY_META,
  getCompatDisplayLabel,
  getCompatDisplayStatus,
} from "@/components/compat/verdict-meta";

// A defensive ceiling on how many icon+tooltip elements ever mount, well
// above the real-world host catalog size — NOT a display target. The pill
// is meant to grow and use all the width it has (up to the tunnel toolbar)
// showing every host that fits; only past that real, measured limit does a
// "+N" badge appear. This just bounds worst-case DOM/measurement cost if
// the catalog ever grows unexpectedly large.
const MAX_RENDERED_HOST_ICONS = 40;

// Mirrors the Tailwind classes on the icon row and pill below (h-4/w-4
// icons, gap-1 between every child, px-2 pill padding) so the measured
// width maps to an exact icon count instead of an approximation.
const HOST_ICON_WIDTH_PX = 16;
const HOST_ICON_GAP_PX = 4;
const PILL_PADDING_X_PX = 16;
// Conservative estimate for the "+N" badge's own width (up to 3 digits) —
// erring high just means the badge appears one icon earlier than strictly
// necessary, never that it gets clipped or undercounts.
const HIDDEN_BADGE_WIDTH_PX = 28;

/**
 * How many host icons fit in `availableWidthPx` (the strip's own measured
 * width) before a "+N" badge is needed. Exported for unit testing without
 * mounting a ResizeObserver.
 */
export function computeVisibleHostIconCount(
  availableWidthPx: number,
  totalCount: number,
  cap: number
): number {
  const max = Math.max(0, Math.min(totalCount, cap));
  if (max === 0) return 0;
  const innerWidth = Math.max(0, availableWidthPx - PILL_PADDING_X_PX);
  const slot = HOST_ICON_WIDTH_PX + HOST_ICON_GAP_PX;
  const widthForAllIcons =
    max * HOST_ICON_WIDTH_PX + (max - 1) * HOST_ICON_GAP_PX;
  // Skip reserving badge space only when nothing is hidden at all — if the
  // cap itself is hit (totalCount > max), a badge for the beyond-cap hosts
  // is unavoidable even when every capped icon fits on its own.
  if (totalCount <= max && widthForAllIcons <= innerWidth) return max;
  const withBadge = Math.floor((innerWidth - HIDDEN_BADGE_WIDTH_PX) / slot);
  return Math.min(max, Math.max(0, withBadge));
}

/**
 * Tracks the rendered width of a flex-shrunk container via ResizeObserver.
 * Returns 0 until the first layout pass measures it — callers should treat
 * 0 as "unknown" and fall back to their un-measured default.
 */
function useMeasuredWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

// Flagship integrations lead the strip in this exact order; MCPJam — our
// own reference client — always trails. Everything else keeps whatever
// order it arrived in (the catalog's own order), placed in between.
const HOST_ORDER_LEADING = ["agentcore", "mistral", "goose"];
const HOST_ORDER_TRAILING = "mcpjam";

export function sortReportsByHostPriority(
  reports: HostCompatReport[]
): HostCompatReport[] {
  const leading = HOST_ORDER_LEADING.map((hostId) =>
    reports.find((report) => report.hostId === hostId)
  ).filter((report): report is HostCompatReport => report !== undefined);
  const trailing = reports.filter(
    (report) => report.hostId === HOST_ORDER_TRAILING
  );
  const middle = reports.filter(
    (report) =>
      !HOST_ORDER_LEADING.includes(report.hostId) &&
      report.hostId !== HOST_ORDER_TRAILING
  );
  return [...leading, ...middle, ...trailing];
}

export function summarizeReports(reports: HostCompatReport[]): string {
  if (reports.length === 0) return "checking…";
  const counts = reports.reduce(
    (acc, report) => {
      const status = getCompatDisplayStatus(report);
      if (status === "green") {
        acc.green += 1;
      } else if (status === "orange") {
        if (report.verdict === "degraded" || report.verdict === "blocked") {
          acc.unsupported += 1;
        } else {
          acc.unverified += 1;
        }
      }
      return acc;
    },
    { green: 0, orange: 0, unsupported: 0, unverified: 0 }
  );
  const parts: string[] = [];
  if (counts.green > 0) parts.push(`supported in ${counts.green}`);
  if (counts.unsupported > 0) {
    parts.push(`unsupported in ${counts.unsupported}`);
  }
  if (counts.unverified > 0) {
    parts.push(`not verified in ${counts.unverified}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "no result available";
}

/**
 * Presentational compat strip — a row of host logos with verdict dots and a
 * per-host tooltips. Split from the data-fetching wrapper so it can be
 * rendered from pre-evaluated reports without re-fetching tools.
 */
export function HostCompatStripView({
  serverName,
  reports,
  onOpenDetails,
  themeMode = "light",
  analysisStatus = "ready",
}: {
  serverName: string;
  reports: HostCompatReport[];
  onOpenDetails?: () => void;
  themeMode?: HostThemeMode;
  analysisStatus?: "analyzing" | "ready" | "failed";
}) {
  const analysisLabel =
    analysisStatus === "analyzing"
      ? "Checking compatibility…"
      : analysisStatus === "failed"
      ? "Compatibility checks unavailable"
      : null;
  const [containerRef, availableWidth] = useMeasuredWidth<HTMLDivElement>();
  const sortedReports = sortReportsByHostPriority(reports);
  // Width isn't measured yet (0) on the first paint and in jsdom, where the
  // stub ResizeObserver never fires — fall back to the un-clipped cap so
  // both cases render the same as before this measurement existed.
  const visibleCount =
    availableWidth > 0
      ? computeVisibleHostIconCount(
          availableWidth,
          sortedReports.length,
          MAX_RENDERED_HOST_ICONS
        )
      : Math.min(sortedReports.length, MAX_RENDERED_HOST_ICONS);
  const visibleReports = sortedReports.slice(0, visibleCount);
  const hiddenReports = sortedReports.slice(visibleCount);

  return (
    <div
      ref={containerRef}
      data-server-card-context-menu-exempt
      className="flex min-w-0 flex-1 items-center gap-2"
      onClick={(e) => e.stopPropagation()}
    >
      {/* The +N overflow badge below is a sibling, not a child, of this
          role=button region — nesting a focusable control inside another
          interactive element confuses screen readers and (since keydown
          bubbles regardless of the inner control's own handling) would let
          Enter/Space on the badge also fire this region's onOpenDetails. */}
      <div className="inline-flex max-w-full flex-nowrap items-center gap-1 overflow-hidden rounded-full border border-border/70 bg-muted/30 px-2 py-0.5">
        <div
          role={onOpenDetails ? "button" : undefined}
          tabIndex={onOpenDetails ? 0 : undefined}
          onClick={onOpenDetails}
          onKeyDown={(e) => {
            if (!onOpenDetails) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpenDetails();
            }
          }}
          aria-label={`Host compatibility for ${serverName}: ${
            analysisLabel ?? summarizeReports(reports)
          }`}
          className={`flex min-w-0 shrink items-center gap-1 rounded-full transition-colors ${
            onOpenDetails ? "cursor-pointer hover:bg-accent/60" : "cursor-default"
          }`}
        >
          {analysisLabel ? (
            <span className="inline-flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
              {analysisStatus === "analyzing" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : null}
              {analysisLabel}
            </span>
          ) : (
            visibleReports.map((report) => {
              const status = getCompatDisplayStatus(report);
              const meta = status ? COMPAT_DISPLAY_META[status] : null;
              return (
                <Tooltip key={report.hostId}>
                  <TooltipTrigger asChild>
                    <span className="relative inline-flex h-4 w-4 items-center justify-center">
                      <img
                        src={
                          report.logoSrcByTheme?.[themeMode] ?? report.logoSrc
                        }
                        alt={report.hostLabel}
                        className="h-3.5 w-3.5 rounded-[3px] object-contain"
                      />
                      {meta ? (
                        <span
                          className={`absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-background ${meta.dot}`}
                        />
                      ) : null}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    sideOffset={4}
                    variant="muted"
                    className="max-w-56 px-2.5 text-left [text-wrap:normal]"
                  >
                    <span className="font-medium">
                      {report.hostLabel}
                      {meta ? `: ${getCompatDisplayLabel(report)}` : ""}
                    </span>
                    {report.findings[0] ? (
                      <>
                        {": "}
                        {report.findings[0].title}
                        {report.findings.length > 1
                          ? ` (+${report.findings.length - 1} more)`
                          : ""}
                      </>
                    ) : null}
                  </TooltipContent>
                </Tooltip>
              );
            })
          )}
        </div>
        {!analysisLabel && hiddenReports.length > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`${hiddenReports.length} more hosts: ${hiddenReports
                  .map((report) => report.hostLabel)
                  .join(", ")}`}
                className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-muted/50 px-1 text-[9px] font-medium text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                +{hiddenReports.length}
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              sideOffset={4}
              variant="muted"
              className="max-w-56 px-2.5 text-left [text-wrap:normal]"
            >
              {hiddenReports.map((report) => report.hostLabel).join(", ")}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
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
  const { reports, analysisStatus } = useHostCompatReports(server);
  return (
    <HostCompatStripView
      serverName={server.name}
      reports={reports}
      onOpenDetails={onOpenDetails}
      analysisStatus={analysisStatus}
    />
  );
}
