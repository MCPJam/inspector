import { useLocation } from "react-router";
import { HostOverlayBar } from "@/components/hosts/HostOverlayBar";
import type { GlobalHostBarProps } from "@/components/Header";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { routePaths } from "@/lib/app-navigation";

export function GlobalHostBar({
  projectId,
  onEditHost,
  onCanvasReplaceHost,
}: GlobalHostBarProps) {
  const location = useLocation();
  const [previewedHostId, setPreviewedHostId] = usePreviewedHostId(projectId);

  // While the Connect host canvas is open, the client selector lives INSIDE
  // the canvas (`HostCanvasSelector`) — hide the header instance so the
  // control isn't duplicated. Mirrors HostsTab's open-canvas condition:
  // on the hosts route with either a URL host id or a previewed fallback.
  const onHostsRoute =
    location.pathname === routePaths.hosts ||
    location.pathname.startsWith(`${routePaths.hosts}/`);
  const urlHostId = onHostsRoute
    ? (location.pathname
        .slice(`${routePaths.hosts}/`.length)
        .split("/")[0] || null)
    : null;
  if (onHostsRoute && (urlHostId || previewedHostId)) {
    return null;
  }

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
