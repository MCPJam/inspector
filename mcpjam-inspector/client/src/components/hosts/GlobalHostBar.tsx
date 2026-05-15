import { HostOverlayBar } from "@/components/hosts/HostOverlayBar";
import type { GlobalHostBarProps } from "@/components/Header";
import { usePreviewedHostId } from "@/hooks/use-previewed-host-id";

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
