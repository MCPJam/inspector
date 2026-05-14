import { useCallback, useEffect, useState, type ReactNode } from "react";
import { HostBuilderView } from "./hosts/HostBuilderView";
import { HostOverlayBar } from "./hosts/HostOverlayBar";

const PREVIEWED_HOST_STORAGE_KEY = "mcp-previewed-host-id";

function loadPreviewedHostId(projectId: string): string | null {
  try {
    const raw = localStorage.getItem(PREVIEWED_HOST_STORAGE_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw) as Record<string, string | null>;
    const value = all[projectId];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function savePreviewedHostId(
  projectId: string,
  hostId: string | null,
): void {
  try {
    const raw = localStorage.getItem(PREVIEWED_HOST_STORAGE_KEY);
    const all = raw ? JSON.parse(raw) : {};
    if (hostId) {
      all[projectId] = hostId;
    } else {
      delete all[projectId];
    }
    localStorage.setItem(PREVIEWED_HOST_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // ignore
  }
}

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
  const [previewedHostId, setPreviewedHostId] = useState<string | null>(() =>
    projectId ? loadPreviewedHostId(projectId) : null,
  );

  useEffect(() => {
    setPreviewedHostId(projectId ? loadPreviewedHostId(projectId) : null);
  }, [projectId]);

  const handleChangePreviewedHostId = useCallback(
    (hostId: string | null) => {
      setPreviewedHostId(hostId);
      if (projectId) savePreviewedHostId(projectId, hostId);
    },
    [projectId],
  );

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
          onChangePreviewedHostId={handleChangePreviewedHostId}
          onEditHost={(hostId) => onSelectHost(hostId)}
        />
      </div>
      <div className="min-h-0 flex-1">{serversTabElement}</div>
    </div>
  );
}
