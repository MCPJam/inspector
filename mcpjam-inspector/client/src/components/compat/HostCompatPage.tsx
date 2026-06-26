import { Boxes } from "lucide-react";
import type { ServerWithName } from "@/state/app-types";
import { useServerToolsData } from "@/lib/host-compat/use-host-compat";
import { HostCompatContent } from "@/components/compat/HostCompatContent";

/**
 * Standalone Compatibility destination — the full-page "does my server work on
 * these hosts?" report for the currently-selected server. Reuses the same
 * engine + `HostCompatContent` as the server-detail modal tab; the only extra
 * job here is fetching the tools list (the modal already holds one).
 *
 * The "Test in host" CTA is intentionally absent on this page: it needs the
 * project-server-ref id the modal resolves, so we pass no `serverId` and
 * `HostCompatContent` hides the CTA (`canCreateHosts` is false). The matrix +
 * conformance gate are the value here; creating a host stays in the modal.
 */
export function HostCompatPage({
  server,
  projectId,
}: {
  server: ServerWithName | null;
  projectId?: string | null;
}) {
  // Hook runs unconditionally; it no-ops for a null/disconnected server.
  const toolsData = useServerToolsData(server);

  if (!server) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <Boxes className="h-6 w-6 text-muted-foreground" />
        <div className="text-sm font-medium text-foreground">
          No server selected
        </div>
        <div className="max-w-xs text-xs text-muted-foreground">
          Select a connected server above to check whether it works on each
          host.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-5">
      <div className="mb-3">
        <h1 className="text-base font-semibold text-foreground">
          Compatibility
        </h1>
        <p className="text-xs text-muted-foreground">
          Whether <span className="font-medium">{server.name}</span> works on
          each host — spec conformance first, then per-host apps &amp; server
          gaps.
        </p>
      </div>
      <HostCompatContent
        server={server}
        toolsData={toolsData}
        projectId={projectId}
      />
    </div>
  );
}
