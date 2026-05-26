import { ClientOverlayBar } from "@/components/clients/ClientOverlayBar";
import type { GlobalHostBarProps } from "@/components/Header";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";

export function GlobalClientBar({
  projectId,
  onEditHost,
  onCanvasReplaceHost,
}: GlobalHostBarProps) {
  const [previewedHostId, setPreviewedHostId] = usePreviewedHostId(projectId);
  return (
    <ClientOverlayBar
      projectId={projectId}
      previewedHostId={previewedHostId}
      onChangePreviewedHostId={setPreviewedHostId}
      onEditHost={onEditHost}
      onCanvasReplaceHost={onCanvasReplaceHost}
    />
  );
}
