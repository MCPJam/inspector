import { useMemo } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { Loader2 } from "lucide-react";
import { useHost } from "@/hooks/useClients";
import { useProjectServers } from "@/hooks/useProjects";
import { useSharedAppState } from "@/state/app-state-context";
import { RedesignedClientCanvas } from "@/components/clients/redesigned/canvas/RedesignedClientCanvas";
import { buildRedesignedHostCanvas } from "@/components/clients/redesigned/canvas/canvasBuilder";
import {
  emptyHostConfigInputV2,
  hostConfigDtoToInput,
} from "@/lib/client-config-v2";
import { buildClientsPath, useAppNavigate } from "@/lib/app-navigation";

/**
 * Read-only embedding of the Connect "Client" graph for the chatbox's
 * bound host. Identity edits live on the Connect tab; clicking anywhere
 * in the canvas routes there via `onRequestEdit`.
 */
type ChatboxHostCanvasPanelProps = {
  hostId: string;
  projectId: string;
  isAuthenticated: boolean;
};

export function ChatboxHostCanvasPanel({
  hostId,
  projectId,
  isAuthenticated,
}: ChatboxHostCanvasPanelProps) {
  const navigate = useAppNavigate();
  const { host } = useHost({ isAuthenticated, hostId });
  const { servers } = useProjectServers({ projectId, isAuthenticated });
  const sharedAppState = useSharedAppState();
  const connectionStatusByName = sharedAppState.servers;

  const projectServersForCanvas = useMemo(
    () =>
      (servers ?? []).map((s) => ({
        id: s._id,
        name: s.name,
        url: s.url ?? undefined,
        connectionStatus:
          connectionStatusByName[s.name]?.connectionStatus ?? "disconnected",
      })),
    [servers, connectionStatusByName],
  );

  const viewModel = useMemo(() => {
    const draft = host
      ? { ...hostConfigDtoToInput(host.config), optionalServerIds: [] }
      : emptyHostConfigInputV2();
    return buildRedesignedHostCanvas(
      {
        hostName: host?.name ?? "",
        draft,
        savedSnapshotId: host?.config?.id ?? "",
        isDirty: false,
        projectServers: projectServersForCanvas,
      },
      [],
    );
  }, [host, projectServersForCanvas]);

  const handleRequestEdit = () => {
    navigate(buildClientsPath(hostId));
  };

  if (!host) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        <span className="text-sm">Loading client…</span>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 p-3">
      <ReactFlowProvider>
        <RedesignedClientCanvas
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
