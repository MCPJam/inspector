import { useEffect, type ReactNode } from "react";
import { HostBuilderView } from "./hosts/HostBuilderView";
import { HostOverlayBar } from "./hosts/HostOverlayBar";
import { usePreviewedHostId } from "@/hooks/use-previewed-host-id";

interface HostsTabProps {
  projectId: string | null;
  isAuthenticated: boolean;
  selectedHostId: string | null;
  onSelectHost: (hostId: string | null) => void;
  serversTabElement: ReactNode;
}

export function HostsTab({
  projectId,
  selectedHostId,
  onSelectHost,
  serversTabElement,
}: HostsTabProps) {
  const [previewedHostId, setPreviewedHostId] = usePreviewedHostId(projectId);

  useEffect(() => {
    if (selectedHostId) onSelectHost(null);
    // selectedHostId/onSelectHost intentionally omitted: this effect resets
    // host context when the active project changes, not when the selection
    // changes within the same project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  if (!projectId) return null;

  if (selectedHostId) {
    return (
      <HostBuilderView
        hostId={selectedHostId}
        projectId={projectId}
        onBack={() => onSelectHost(null)}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-8 pt-6 pb-3">
        <HostOverlayBar
          projectId={projectId}
          previewedHostId={previewedHostId}
          onChangePreviewedHostId={setPreviewedHostId}
          onEditHost={(hostId) => onSelectHost(hostId)}
        />
      </div>
      <div className="min-h-0 flex-1">{serversTabElement}</div>
    </div>
  );
}
