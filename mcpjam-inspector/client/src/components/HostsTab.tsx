import { useEffect, useState, type ReactNode } from "react";
import { HostBuilderView } from "./hosts/HostBuilderView";
import { HostOverlayBar } from "./hosts/HostOverlayBar";
import { HostsConnectAddServerSlotContext } from "./hosts/HostsConnectAddServerSlotContext";
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
  const [addServerSlotEl, setAddServerSlotEl] = useState<HTMLDivElement | null>(
    null,
  );

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
        onSwitchHost={(nextId) => onSelectHost(nextId)}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <HostsConnectAddServerSlotContext.Provider value={addServerSlotEl}>
        <div
          className="shrink-0 border-b border-border/40 px-8 py-2.5"
          data-testid="hosts-tab-header-chrome"
        >
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <HostOverlayBar
              projectId={projectId}
              previewedHostId={previewedHostId}
              onChangePreviewedHostId={setPreviewedHostId}
              onEditHost={(hostId) => onSelectHost(hostId)}
            />
            <div
              ref={setAddServerSlotEl}
              className="flex shrink-0 items-center gap-2"
              data-testid="hosts-tab-add-server-slot"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1">{serversTabElement}</div>
      </HostsConnectAddServerSlotContext.Provider>
    </div>
  );
}
