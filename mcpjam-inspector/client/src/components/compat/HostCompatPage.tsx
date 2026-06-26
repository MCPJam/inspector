import { Boxes } from "lucide-react";
import type { ServerWithName } from "@/state/app-types";
import { useServerToolsData } from "@/lib/host-compat/use-host-compat";
import { HostCompatContent } from "@/components/compat/HostCompatContent";
import { HostCompatMatrix } from "@/components/compat/HostCompatMatrix";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Standalone Compatibility destination — "does my server work on these hosts?".
 *
 * With multiple connected servers it leads with a servers × hosts matrix
 * (click a row to drill in); the selected server's full report (conformance
 * gate + per-host apps/server findings) renders below. With a single server it
 * is just that report. Reuses the same engine + `HostCompatContent` as the
 * server-detail modal tab.
 *
 * The "Test in host" CTA is intentionally absent on this page: it needs the
 * project-server-ref id the modal resolves, so `HostCompatContent` (passed no
 * `serverId`) hides it.
 */
export function HostCompatPage({
  servers,
  selectedServer,
  onSelectServer,
  projectId,
}: {
  /** Connected servers eligible for evaluation. */
  servers: ServerWithName[];
  /** The server whose full report shows below the matrix. */
  selectedServer: ServerWithName | null;
  onSelectServer: (name: string) => void;
  projectId?: string | null;
}) {
  // Anchor the detail to a CONNECTED server (the matrix only lists connected
  // ones), falling back to the first so the report is never blank — and so the
  // matrix highlight (`detailServer.name`) always matches a real row. Hook runs
  // unconditionally; it no-ops for a null/empty server.
  const detailServer = selectedServer ?? servers[0] ?? null;
  const toolsData = useServerToolsData(detailServer);

  if (servers.length === 0) {
    return (
      <EmptyState
        icon={Boxes}
        title="No connected server"
        description="Connect a server above to check whether it works on each host."
        className="h-full"
      />
    );
  }

  const showMatrix = servers.length > 1;

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-5">
      <div className="mb-3">
        <h1 className="text-base font-semibold text-foreground">
          Compatibility
        </h1>
        <p className="text-xs text-muted-foreground">
          Whether your servers work on each host — spec conformance first, then
          per-host apps &amp; server gaps.
        </p>
      </div>

      {showMatrix && (
        <div className="mb-5">
          <HostCompatMatrix
            servers={servers}
            selectedServerName={detailServer?.name}
            onSelectServer={onSelectServer}
          />
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Select a server to see its full report.
          </p>
        </div>
      )}

      {detailServer && (
        <section>
          {showMatrix && (
            <h2 className="mb-1.5 text-sm font-medium text-foreground">
              {detailServer.name}
            </h2>
          )}
          <HostCompatContent
            server={detailServer}
            toolsData={toolsData}
            projectId={projectId}
            source="compat_page"
          />
        </section>
      )}
    </div>
  );
}
