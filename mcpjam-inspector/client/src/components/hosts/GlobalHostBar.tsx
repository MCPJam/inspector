import { HostOverlayBar } from "@/components/hosts/HostOverlayBar";
import { usePreviewedHostId } from "@/hooks/use-previewed-host-id";

interface GlobalHostBarProps {
  projectId: string;
  onEditHost: (hostId: string) => void;
  onCanvasReplaceHost?: (hostId: string) => void;
}

export function GlobalHostBar({
  projectId,
  onEditHost,
  onCanvasReplaceHost,
}: GlobalHostBarProps) {
  const [previewedHostId, setPreviewedHostId] = usePreviewedHostId(projectId);
  return (
    <HostOverlayBar
      projectId={projectId}
      previewedHostId={previewedHostId}
      onChangePreviewedHostId={setPreviewedHostId}
      onEditHost={onEditHost}
      onCanvasReplaceHost={onCanvasReplaceHost}
    />
  );
}
