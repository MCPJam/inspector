import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import type { ServerWithName } from "@/state/app-types";
import { buildHostCompatProfiles } from "@/lib/host-compat/profiles";
import { useHostCompatReports } from "@/lib/host-compat/use-host-compat";
import type { HostCompatReport } from "@/lib/host-compat/types";
import { VERDICT_META } from "@/components/compat/verdict-meta";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

type HostColumn = {
  id: string;
  label: string;
  logoSrc: string;
  logoSrcByTheme?: { light: string; dark: string };
};

export type ColumnSummary = { works: number; loaded: number };

/**
 * For one host column, count how many of the loaded servers "work" there.
 * Pure + server-object-free so it unit-tests cleanly; the matrix feeds it
 * `servers.map((s) => byServer[s.name])` so stale entries for removed servers
 * never leak into the count.
 */
export function summarizeColumn(
  perServerReports: Array<HostCompatReport[] | undefined>,
  hostId: string,
): ColumnSummary {
  let works = 0;
  let loaded = 0;
  for (const reports of perServerReports) {
    if (!reports) continue;
    const r = reports.find((x) => x.hostId === hostId);
    if (!r) continue;
    loaded += 1;
    if (r.verdict === "works") works += 1;
  }
  return { works, loaded };
}

/**
 * One server row. Each row owns its own `useHostCompatReports` (per-server
 * tool fetch + widget scan), so the matrix can map over a dynamic server list
 * without breaking the rules of hooks. Verdicts bubble up via `onReports` so
 * the matrix can roll up per-column summaries.
 */
function MatrixRow({
  server,
  hosts,
  selected,
  onSelect,
  onReports,
}: {
  server: ServerWithName;
  hosts: HostColumn[];
  selected: boolean;
  onSelect: (name: string) => void;
  onReports: (name: string, reports: HostCompatReport[]) => void;
}) {
  const { reports } = useHostCompatReports(server);

  const byHost = useMemo(() => {
    const m = new Map<string, HostCompatReport>();
    for (const r of reports) m.set(r.hostId, r);
    return m;
  }, [reports]);

  // `reports` is memoized by useHostCompatReports, so this fires only when the
  // server's evaluation actually changes — not on every parent re-render.
  useEffect(() => {
    onReports(server.name, reports);
  }, [server.name, reports, onReports]);

  return (
    <tr
      // Mouse convenience: click anywhere on the row to select. The real
      // keyboard/AT control is the button in the server cell below — the row
      // carries no button role so assistive tech isn't told a table row is a
      // button.
      onClick={() => onSelect(server.name)}
      className={`border-t border-border/50 ${
        selected ? "bg-muted/50" : "hover:bg-muted/30"
      }`}
    >
      <td className="sticky left-0 z-10 bg-inherit px-3 py-2">
        <button
          type="button"
          aria-pressed={selected}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(server.name);
          }}
          className="block max-w-[11rem] truncate rounded text-left text-xs font-medium text-foreground hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {server.name}
        </button>
      </td>
      {hosts.map((h) => {
        const verdict = byHost.get(h.id)?.verdict ?? "unknown";
        const meta = VERDICT_META[verdict];
        return (
          <td key={h.id} className="px-2 py-2 text-center">
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={`inline-block h-2 w-2 rounded-full ${meta.dot}`}
                  aria-label={`${meta.label} on ${h.label}`}
                />
              </TooltipTrigger>
              <TooltipContent side="top" variant="muted">
                {h.label}: {meta.label}
              </TooltipContent>
            </Tooltip>
          </td>
        );
      })}
    </tr>
  );
}

/**
 * Multi-server compatibility matrix — rows are connected servers, columns are
 * hosts, each cell is the server's aggregate verdict on that host. Clicking a
 * row selects that server (the page shows its full report below). Per-column
 * footer summarizes "works in N/M".
 */
export function HostCompatMatrix({
  servers,
  selectedServerName,
  onSelectServer,
}: {
  servers: ServerWithName[];
  selectedServerName?: string;
  onSelectServer: (name: string) => void;
}) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const hosts = useMemo<HostColumn[]>(
    () =>
      buildHostCompatProfiles().map((p) => ({
        id: p.id,
        label: p.label,
        logoSrc: p.logoSrc,
        logoSrcByTheme: p.logoSrcByTheme,
      })),
    [],
  );

  const [byServer, setByServer] = useState<Record<string, HostCompatReport[]>>(
    {},
  );
  const handleReports = useCallback(
    (name: string, reports: HostCompatReport[]) => {
      setByServer((prev) =>
        prev[name] === reports ? prev : { ...prev, [name]: reports },
      );
    },
    [],
  );

  const perServerReports = servers.map((s) => byServer[s.name]);

  return (
    <div className="overflow-x-auto rounded-md border border-border/60">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="bg-muted/30">
            <th className="sticky left-0 z-10 bg-muted/30 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Server
            </th>
            {hosts.map((h) => (
              <th key={h.id} className="px-2 py-2 text-center">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <img
                      src={h.logoSrcByTheme?.[themeMode] ?? h.logoSrc}
                      alt={h.label}
                      className="mx-auto h-4 w-4 rounded-[3px] object-contain"
                    />
                  </TooltipTrigger>
                  <TooltipContent side="top" variant="muted">
                    {h.label}
                  </TooltipContent>
                </Tooltip>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {servers.map((s) => (
            <MatrixRow
              key={s.name}
              server={s}
              hosts={hosts}
              selected={s.name === selectedServerName}
              onSelect={onSelectServer}
              onReports={handleReports}
            />
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border/50">
            <td className="sticky left-0 z-10 bg-background px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              Works
            </td>
            {hosts.map((h) => {
              const { works, loaded } = summarizeColumn(perServerReports, h.id);
              return (
                <td
                  key={h.id}
                  className="px-2 py-1.5 text-center text-[11px] text-muted-foreground"
                >
                  {loaded > 0 ? `${works}/${loaded}` : "—"}
                </td>
              );
            })}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
