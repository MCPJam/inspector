import { ClientSelectionSync } from "./ClientSelectionSync";
import type { ClientBootstrapProps } from "@/components/Header";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { routePaths, useCurrentPathname } from "@/lib/app-navigation";
import { stripProjectFromPath } from "@/lib/project-route";

export function ProjectClientBootstrap({ projectId }: ClientBootstrapProps) {
  const pathname = useCurrentPathname();
  const [previewedHostId] = usePreviewedHostId(projectId);

  // The Client canvas owns URL-to-selection reconciliation. Keep the former
  // header's initialization scope without rendering any global controls.
  const logicalPathname = stripProjectFromPath(pathname);
  const onHostsRoute =
    logicalPathname === routePaths.hosts ||
    logicalPathname.startsWith(`${routePaths.hosts}/`);
  const urlHostId = onHostsRoute
    ? logicalPathname.slice(`${routePaths.hosts}/`.length).split("/")[0] || null
    : null;
  if (onHostsRoute && (urlHostId || previewedHostId)) {
    return null;
  }

  return <ClientSelectionSync projectId={projectId} />;
}
