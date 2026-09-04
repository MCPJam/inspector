import { Loader2 } from "lucide-react";
import type { ServerWithName } from "@/state/app-types";
import { useHostCompatReports } from "@/lib/host-compat/use-host-compat";
import type { HostCompatReport } from "@/lib/host-compat/types";
import type { HostThemeMode } from "@/lib/client-styles";
import { usePreferencesStoreWithDefaults } from "@/stores/preferences/preferences-provider";
import { getHostTintBackground } from "@/lib/host-ui-metadata";
import { getCompatDisplayStatus } from "@/components/compat/verdict-meta";

/**
 * Logos in the stack. The pill is a high-level "who supports this" signal, not
 * a catalog — the full supported / unsupported list lives one click away on the
 * detail modal's Clients tab, so the stack stays at a fixed three and the count
 * carries the rest.
 */
export const PILL_MAX_LOGOS = 3;

// The two hosts most people are checking for lead the stack whenever they
// support the server; everything else keeps the catalog's own order behind
// them.
const PILL_ORDER_LEADING = ["chatgpt", "claude"];

/**
 * Clients that explicitly support this server. `green` is the existing
 * two-color compat semantic: the host profile covers the server's relevant
 * requirements. Anything unsupported, unverified or still uncolored is not a
 * supporter and is left to the Clients tab to explain.
 */
export function selectSupportingReports(
  reports: HostCompatReport[],
): HostCompatReport[] {
  return reports.filter((report) => getCompatDisplayStatus(report) === "green");
}

export function sortSupportersForPill(
  reports: HostCompatReport[],
): HostCompatReport[] {
  const leading = PILL_ORDER_LEADING.map((hostId) =>
    reports.find((report) => report.hostId === hostId),
  ).filter((report): report is HostCompatReport => report !== undefined);
  const rest = reports.filter(
    (report) => !PILL_ORDER_LEADING.includes(report.hostId),
  );
  return [...leading, ...rest];
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
    { green: 0, orange: 0, unsupported: 0, unverified: 0 },
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
 * Presentational support pill — one chip carrying a supporter count and up to
 * three supporting client logos. Split from the data-fetching wrapper so it can
 * be rendered from pre-evaluated reports without re-fetching tools.
 */
export function ClientSupportPillView({
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
  const supporters = sortSupportersForPill(selectSupportingReports(reports));
  const visibleSupporters = supporters.slice(0, PILL_MAX_LOGOS);
  // Only the settled, no-supporter case earns the destructive treatment —
  // while analysis is in flight (or has failed) we don't yet know that nothing
  // supports the server, and claiming so in red would be wrong.
  const isEmpty = analysisLabel === null && supporters.length === 0;

  const ariaLabel = `Client support for ${serverName}: ${
    analysisLabel ?? summarizeReports(reports)
  }`;
  const pillClassName = `inline-flex h-6.5 max-w-full items-center gap-2 overflow-hidden rounded-full border px-2 text-left transition-colors ${
    isEmpty
      ? "border-destructive/40 bg-destructive/10"
      : "border-border/70 bg-muted"
  } ${
    onOpenDetails
      ? "cursor-pointer hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
      : "cursor-default"
  }`;

  const pillContent = (
    <>
      {analysisLabel ? (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          {analysisStatus === "analyzing" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : null}
          {analysisLabel}
        </span>
      ) : isEmpty ? (
        <span className="truncate text-xs font-medium text-destructive">
          No clients support this server
        </span>
      ) : (
        <>
          <span className="flex shrink-0 items-center">
            {visibleSupporters.map((report, index) => (
              <span
                key={report.hostId}
                className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center overflow-hidden rounded-full ${
                  index > 0 ? "-ml-1" : ""
                }`}
                style={{ background: getHostTintBackground(report.hostId) }}
              >
                <img
                  src={report.logoSrcByTheme?.[themeMode] ?? report.logoSrc}
                  // The pill's own aria-label already names the support
                  // state; the marks are decoration on top of it.
                  alt=""
                  className="h-3.5 w-3.5 rounded-[3px] object-contain"
                />
              </span>
            ))}
          </span>
          <span className="truncate text-xs font-medium text-foreground">
            Supported by {supporters.length}
          </span>
        </>
      )}
    </>
  );

  return (
    <div
      data-server-card-context-menu-exempt
      className="flex min-w-0 flex-1 items-center gap-2"
      onClick={(e) => e.stopPropagation()}
    >
      {onOpenDetails ? (
        <button
          type="button"
          onClick={onOpenDetails}
          aria-label={ariaLabel}
          className={pillClassName}
        >
          {pillContent}
        </button>
      ) : (
        <div aria-label={ariaLabel} className={pillClassName}>
          {pillContent}
        </div>
      )}
    </div>
  );
}

/**
 * The server connection card's client-support signal — the "from the moment you
 * connect" surface of the host-compat design
 * (design-explorations/host-compat-report.md), reduced from a per-host logo row
 * to a single pill. Clicking opens the detail modal's Clients tab, which holds
 * the full supported / unsupported breakdown.
 */
export function ClientSupportPill({
  server,
  onOpenDetails,
}: {
  server: ServerWithName;
  onOpenDetails?: () => void;
}) {
  const { reports, analysisStatus } = useHostCompatReports(server);
  // Hosts with a themed mark (Goose, Cline) ship a light and a dark logo;
  // without the active theme the view falls back to "light" and renders a
  // light-on-dark mark in dark mode. Read via the defaults-backed hook: the
  // card is rendered without app providers in a good many unit tests, and a
  // logo variant is not worth making those throw.
  const themeMode = usePreferencesStoreWithDefaults((s) => s.themeMode);
  return (
    <ClientSupportPillView
      serverName={server.name}
      reports={reports}
      onOpenDetails={onOpenDetails}
      themeMode={themeMode}
      analysisStatus={analysisStatus}
    />
  );
}
