import { useLocation } from "react-router";
import { HostOverlayBar } from "@/components/hosts/HostOverlayBar";
import type { GlobalHostBarProps } from "@/components/Header";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { routePaths } from "@/lib/app-navigation";
import { stripProjectFromPath } from "@/lib/project-route";

export function GlobalHostBar({
  projectId,
  onEditHost,
  onCanvasReplaceHost,
}: GlobalHostBarProps) {
  const location = useLocation();
  const [previewedHostId, setPreviewedHostId] = usePreviewedHostId(projectId);

  // While the Connect host canvas is open, the client selector lives in the
  // canvas's own nav row (`HostCanvasSelector`, beside Servers|Client) — hide
  // the header instance so the control isn't duplicated. Mirrors HostsTab's
  // open-canvas condition:
  // on the hosts route with either a URL host id or a previewed fallback.
  // Matched on the LOGICAL path: the live one is `/p/<projectId>/hosts/<id>`,
  // and comparing that against `/hosts` would report "not on the hosts route"
  // for every hosted visitor — duplicating the selector in the canvas.
  const logicalPathname = stripProjectFromPath(location.pathname);
  const onHostsRoute =
    logicalPathname === routePaths.hosts ||
    logicalPathname.startsWith(`${routePaths.hosts}/`);
  const urlHostId = onHostsRoute
    ? (logicalPathname.slice(`${routePaths.hosts}/`.length).split("/")[0] ||
      null)
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
