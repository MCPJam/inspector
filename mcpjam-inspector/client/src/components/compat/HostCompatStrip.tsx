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

  return (
    <div
      data-server-card-context-menu-exempt
      className="flex min-w-0 flex-1 items-center gap-2"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={onOpenDetails}
        disabled={!onOpenDetails}
        aria-label={`Host compatibility for ${serverName}: ${
          analysisLabel ?? summarizeReports(reports)
        }`}
        className="inline-flex max-w-full flex-nowrap items-center rounded-full border border-border/70 bg-muted/30 px-2 py-0.5 transition-colors hover:bg-accent/60 cursor-pointer disabled:cursor-default"
      >
        {analysisLabel ? (
          <span className="inline-flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
            {analysisStatus === "analyzing" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : null}
            {analysisLabel}
          </span>
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            {reports.map((report) => {
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
            })}
          </div>
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
