import { useCallback, useMemo, type ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { useHost, useHostList } from "@/hooks/useClients";
import { clientDisplayName } from "@/lib/client-display-name";
import { useProjectServers, type RemoteServer } from "@/hooks/useProjects";
import {
  useEnvironmentPreview,
  type EnvironmentPreviewServer,
} from "@/hooks/use-environment-preview";
import { RedesignedHostCanvas } from "@/components/hosts/redesigned/canvas/RedesignedHostCanvas";
import { buildRedesignedHostCanvas } from "@/components/hosts/redesigned/canvas/canvasBuilder";
import type { HostRedesignContext } from "@/components/hosts/redesigned/types";
import {
  emptyHostConfigInputV2,
  hostConfigDtoToInput,
  type HostConfigDtoV2,
} from "@/lib/client-config-v2";
import { buildHostsPath, useAppNavigate } from "@/lib/app-navigation";

/**
 * Read-only embedding of the Connect "Host" graph for an environment's
 * RESOLVED bundle. Mirrors `ScenarioHostCanvasPanel` — pure data →
 * `buildRedesignedHostCanvas` → `<RedesignedHostCanvas readOnly>` — with one
 * difference that drives the whole file: the server set is not the host's own
 * picks, it is whatever the backend resolver says this environment currently
 * resolves to (group-vs-host pick, plus plugin-contributed servers). Clicking
 * anywhere routes to Connect, which owns every field the matrix displays.
 */

/**
 * Builder context for an environment's canvas. Exported (and pure) so the
 * preview→canvas contract is unit-testable without mounting ReactFlow.
 */
export function buildEnvironmentCanvasContext(args: {
  hostName: string;
  /** `host.config` from `useHost`; null while the host is missing/loading. */
  hostConfig: HostConfigDtoV2 | null;
  /** `preview.servers` — the resolver's answer, never re-derived here. */
  previewServers: EnvironmentPreviewServer[];
  /** `useProjectServers().servers`, consulted for the url join ONLY. */
  projectServers: RemoteServer[] | undefined;
}): HostRedesignContext {
  const { hostName, hostConfig, previewServers, projectServers } = args;

  // `hostConfigDtoToInput` requires a non-null DTO; the scenario precedent
  // guards the same way so a dangling host still renders host-less chrome.
  const base = hostConfig
    ? hostConfigDtoToInput(hostConfig)
    : emptyHostConfigInputV2();

  const byId = new Map((projectServers ?? []).map((s) => [s._id, s]));

  return {
    hostName,
    // An environment's server set is CLOSED: everything the resolver returned
    // is required/solid, and nothing else exists. No dashed "optional" cards.
    draft: {
      ...base,
      serverIds: previewServers.map((s) => s.serverId),
      optionalServerIds: [],
    },
    // LOAD-BEARING: the builder draws one card per entry of `projectServers`,
    // so the closed-set rendering rests on this list being built FROM the
    // preview. Never pass the project's full server list here — a non-member
    // project server would surface as a card on an environment that does not
    // include it.
    projectServers: previewServers.map((s) => ({
      id: s.serverId,
      name: s.name,
      // url join only; plugin/unjoinable servers render name-only.
      url: byId.get(s.serverId)?.url ?? undefined,
      // No `connectionStatus`: the builder defaults to "unknown" (neutral
      // dot). Environment servers are connected backend-side per turn, so any
      // dot here would imply a liveness this surface cannot know.
    })),
    savedSnapshotId: hostConfig?.id ?? "",
    isDirty: false,
  };
}

type EnvironmentCanvasPanelProps = {
  projectId: string;
  environmentId: string;
  hostId: string;
  /** The selected row's `revision` — refetches the preview after a Save. */
  revision: number;
  isArchived: boolean;
  isAuthenticated: boolean;
};

export function EnvironmentCanvasPanel({
  projectId,
  environmentId,
  hostId,
  revision,
  isArchived,
  isAuthenticated,
}: EnvironmentCanvasPanelProps) {
  const navigate = useAppNavigate();
  // Archived environments are keyed off the ROW, never off a parsed error: the
  // preview endpoint 409s on them (`ENV_ARCHIVED`), so passing `null` keeps the
  // doomed fetch — including the hook's focus-return refetch — from ever firing.
  const { preview, isLoading, error, refresh } = useEnvironmentPreview(
    projectId,
    isArchived ? null : environmentId,
    revision
  );
  const { host, isLoading: hostLoading } = useHost({ isAuthenticated, hostId });
  const { hosts } = useHostList({
    isAuthenticated,
    projectId,
    includePrivateBacking: true,
  });
  const { servers } = useProjectServers({ projectId, isAuthenticated });

  const viewModel = useMemo(() => {
    if (!preview || !host) return null;
    const listedHost = hosts.find((item) => item.hostId === hostId);
    return buildRedesignedHostCanvas(
      buildEnvironmentCanvasContext({
        hostName:
          (listedHost ? clientDisplayName(listedHost) : null) ??
          host.name ??
          preview.host.hostName ??
          "",
        hostConfig: host.config ?? null,
        previewServers: preview.servers,
        projectServers: servers,
      }),
      []
    );
  }, [preview, host, hosts, hostId, servers]);

  // Stable across renders: the canvas memoizes its matrix context on
  // `onRequestEdit`, so a fresh closure would re-render the matrix subtree
  // through that context on every parent render.
  const handleRequestEdit = useCallback(() => {
    navigate(buildHostsPath(hostId));
  }, [navigate, hostId]);

  if (isArchived) {
    return (
      <FallbackCard>
        Archived — this environment no longer resolves to a live canvas.
      </FallbackCard>
    );
  }

  if (error !== null) {
    return (
      <FallbackCard>
        <span className="block">{error.message}</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-3 h-7 text-xs"
          // The hook keeps the stale `error` across a same-key refetch, so the
          // button itself has to carry the feedback for the click.
          disabled={isLoading}
          onClick={() => refresh()}
        >
          {isLoading ? (
            <Loader2 className="mr-1.5 size-3.5 animate-spin" />
          ) : null}
          Retry
        </Button>
      </FallbackCard>
    );
  }

  if (!preview) {
    return <SpinnerRow label="Resolving environment…" />;
  }

  // `!viewModel` is unreachable given the memo's own guard, but narrowing on the
  // value keeps the compiler — not a comment — as the invariant's enforcer, so a
  // later reorder of these guards can't silently hand ReactFlow a null model.
  if (!host || !viewModel) {
    return hostLoading ? (
      <SpinnerRow label="Loading client…" />
    ) : (
      <FallbackCard>
        The client behind this environment is no longer available.
      </FallbackCard>
    );
  }

  return (
    <div className="h-full min-h-0 p-3">
      <ReactFlowProvider>
        <RedesignedHostCanvas
          viewModel={viewModel}
          selectedNodeId={null}
          onSelectNode={() => {}}
          onClearSelection={() => {}}
          onAddServer={() => {}}
          readOnly
          onRequestEdit={handleRequestEdit}
        />
      </ReactFlowProvider>
    </div>
  );
}

function SpinnerRow({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <Loader2 className="mr-2 size-4 animate-spin" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

function FallbackCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-sm rounded-md border bg-muted/30 p-4 text-center text-xs text-muted-foreground">
        {children}
      </div>
    </div>
  );
}
