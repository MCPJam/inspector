import { useState } from "react";
import { HostIndexPage } from "./hosts/HostIndexPage";
import { HostBuilderView } from "./hosts/HostBuilderView";

interface HostsTabProps {
  projectId: string | null;
  isAuthenticated: boolean;
}

export function HostsTab({ projectId, isAuthenticated }: HostsTabProps) {
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);

  if (!projectId) return null;

  if (selectedHostId) {
    return (
      <HostBuilderView
        hostId={selectedHostId}
        projectId={projectId}
        onBack={() => setSelectedHostId(null)}
      />
    );
  }

  return (
    <HostIndexPage
      projectId={projectId}
      isAuthenticated={isAuthenticated}
      onSelectHost={setSelectedHostId}
    />
  );
}
